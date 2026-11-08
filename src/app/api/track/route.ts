import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  REFERRAL_QUERY_PARAM,
  REFERRAL_RELOAD_WINDOW_MS,
  REFERRAL_TOKEN_PATTERN,
} from "@/lib/referral";
import { clientAddress, isPrivateAddress } from "@/lib/clientAddress";
import { isUniqueConstraintErrorOn } from "@/lib/prismaErrors";
import { isClickLimited, rememberClick } from "@/lib/trackThrottle";

const CORS = { "Access-Control-Allow-Origin": "*" };

const referralTokenPattern = new RegExp(REFERRAL_TOKEN_PATTERN, "i");

// Called cross-origin, from the Merchant's own site (wherever the tracking
// script is embedded), not from this Merchant's own domain — so this is
// the one endpoint that deliberately allows any origin. No sensitive data
// goes in or out, and it carries no financial risk by itself (see
// CONTEXT.md); only a signature-verified Stripe webhook event ever creates
// a Commission.
//
// Returns a Referral Token. The script is responsible for storing it as a
// first-party cookie on the Merchant's own domain (document.cookie, set
// client-side — a Set-Cookie header from this response would be scoped to
// Supaffi's domain, not the Merchant's, and would be useless here) so the
// Merchant's own checkout code can read it later and pass it into Stripe.
export async function GET(req: NextRequest) {
  const host = req.headers.get("host");
  const referralCode = req.nextUrl.searchParams.get(REFERRAL_QUERY_PARAM);
  if (!host) {
    return new NextResponse(null, { status: 400 });
  }

  const merchant = await db.merchant.findUnique({
    where: { domain: host },
    select: { id: true },
  });
  if (!merchant) {
    return new NextResponse(null, { status: 404 });
  }

  // Codes are scoped to the Merchant resolved from the validated request host.
  // Only live codes attribute. A code its Affiliate renamed or deleted
  // (RetiredLinkCode) is not looked up here: the edit dialog tells the
  // Affiliate that old links stop earning, and quietly crediting them anyway
  // would contradict what they were told. Retiring it still keeps the code
  // from ever resolving for someone else.
  const legacyValues = [...req.nextUrl.searchParams.entries()]
    .filter(
      ([parameter]) =>
        parameter.toLowerCase() !== REFERRAL_QUERY_PARAM.toLowerCase() &&
        parameter.toLowerCase() !== "token",
    )
    .map(([parameter, value]) => ({
      parameter: parameter.toLowerCase(),
      value: value.toLowerCase(),
    }));
  const [directCandidates, legacyCandidates] = await Promise.all([
    referralCode
      ? db.affiliateLink.findMany({
          where: {
            merchantId: merchant.id,
            OR: [
              { code: referralCode },
              { legacyAliases: { has: referralCode } },
            ],
          },
          select: {
            id: true,
            code: true,
            legacyAliases: true,
            legacyQueryParamAliases: true,
            importSourceIdentity: true,
            activeFrom: true,
            activeUntil: true,
            commissionRateOverride: true,
            commissionDurationTypeOverride: true,
            commissionDurationMonthsOverride: true,
            attributionWindowDaysOverride: true,
            holdingPeriodDaysOverride: true,
            affiliate: {
              select: {
                id: true,
                customCommissionRate: true,
                program: {
                  select: {
                    defaultCommissionRate: true,
                    commissionDurationType: true,
                    commissionDurationMonths: true,
                    attributionWindowDays: true,
                    holdingPeriodDays: true,
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    legacyValues.length
      ? db.affiliateLink.findMany({
          where: {
            merchantId: merchant.id,
            importSourceIdentity: { not: null },
            OR: legacyValues.map(({ parameter, value }) => ({
              legacyQueryParamAliases: { has: parameter },
              legacyAliases: { has: value },
            })),
          },
          select: {
            id: true,
            code: true,
            legacyAliases: true,
            legacyQueryParamAliases: true,
            importSourceIdentity: true,
            activeFrom: true,
            activeUntil: true,
            commissionRateOverride: true,
            commissionDurationTypeOverride: true,
            commissionDurationMonthsOverride: true,
            attributionWindowDaysOverride: true,
            holdingPeriodDaysOverride: true,
            affiliate: {
              select: {
                id: true,
                customCommissionRate: true,
                program: {
                  select: {
                    defaultCommissionRate: true,
                    commissionDurationType: true,
                    commissionDurationMonths: true,
                    attributionWindowDays: true,
                    holdingPeriodDays: true,
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  type Candidate =
    (typeof directCandidates)[number] | (typeof legacyCandidates)[number];
  const matchingById = new Map<string, Candidate>();
  for (const candidate of directCandidates) {
    if (
      referralCode &&
      (candidate.code === referralCode ||
        (candidate.importSourceIdentity !== null &&
          candidate.legacyAliases.includes(referralCode)))
    ) {
      matchingById.set(candidate.id, candidate);
    }
  }
  for (const candidate of legacyCandidates) {
    if (candidate.importSourceIdentity === null) continue;
    const matches = legacyValues.some(
      ({ parameter, value }) =>
        candidate.legacyQueryParamAliases.includes(parameter) &&
        candidate.legacyAliases.includes(value),
    );
    if (matches) matchingById.set(candidate.id, candidate);
  }
  const matching = [...matchingById.values()];
  const link = matching.length === 1 ? matching[0] : null;
  if (
    !link ||
    (link.activeFrom && link.activeFrom > new Date()) ||
    (link.activeUntil && link.activeUntil < new Date())
  ) {
    return new NextResponse(null, { status: 404 });
  }

  // The browser creates and stores its own token before sending this request.
  // That makes the request idempotent even if a browser, proxy, or filter drops
  // the JSON body: a reload still sends the same token and finds the same Click.
  // We never deduplicate by IP, which many customers can share.
  const heldToken = req.nextUrl.searchParams.get("token");
  let newBrowserToken: string | null = null;
  if (heldToken) {
    const held = await db.click.findUnique({
      where: { referralToken: heldToken },
      select: { linkId: true, createdAt: true, fraudConfirmedAt: true },
    });
    if (
      held &&
      held.linkId === link.id &&
      held.fraudConfirmedAt === null &&
      Date.now() - held.createdAt.getTime() < REFERRAL_RELOAD_WINDOW_MS
    ) {
      return NextResponse.json({ referralToken: heldToken }, { headers: CORS });
    }
    if (!held && referralTokenPattern.test(heldToken)) {
      newBrowserToken = heldToken;
    }
  }

  // Limited only when the address is an internet visitor. A private one means
  // the proxy in front did not report the visitor (an operator's own proxy
  // with no X-Forwarded-For), and every visitor would then share one key and
  // be throttled together.
  const address = clientAddress(req.headers);
  const throttled =
    address !== null && !isPrivateAddress(address) ? address : null;
  if (throttled && isClickLimited(throttled)) {
    return new NextResponse(null, { status: 429, headers: CORS });
  }

  const referralToken = newBrowserToken ?? randomUUID();
  const createdAt = new Date();
  const attributionWindowDays =
    link.attributionWindowDaysOverride ??
    link.affiliate.program.attributionWindowDays;
  const commissionRateSnapshot =
    link.commissionRateOverride ??
    link.affiliate.customCommissionRate ??
    link.affiliate.program.defaultCommissionRate;
  const commissionDurationTypeSnapshot =
    link.commissionDurationTypeOverride ??
    link.affiliate.program.commissionDurationType;
  const commissionDurationMonthsSnapshot =
    commissionDurationTypeSnapshot === "FIXED_MONTHS"
      ? link.commissionDurationTypeOverride === "FIXED_MONTHS"
        ? link.commissionDurationMonthsOverride
        : link.affiliate.program.commissionDurationMonths
      : null;
  const holdingPeriodDaysSnapshot =
    link.holdingPeriodDaysOverride ?? link.affiliate.program.holdingPeriodDays;
  const expiresAt = new Date(
    createdAt.getTime() + attributionWindowDays * 24 * 60 * 60 * 1000,
  );

  try {
    await db.click.create({
      data: {
        merchantId: merchant.id,
        affiliateId: link.affiliate.id,
        linkId: link.id,
        referralToken,
        expiresAt,
        commissionRateSnapshot,
        commissionDurationTypeSnapshot,
        commissionDurationMonthsSnapshot,
        holdingPeriodDaysSnapshot,
        createdAt,
      },
    });
  } catch (error) {
    // Two tabs can start the same visit at once. The unique referral token is
    // the database idempotency key, so the second insert returns the first row.
    if (newBrowserToken && isUniqueConstraintErrorOn(error, "referralToken")) {
      const winner = await db.click.findUnique({
        where: { referralToken: newBrowserToken },
        select: { linkId: true, createdAt: true, fraudConfirmedAt: true },
      });
      if (
        winner &&
        winner.linkId === link.id &&
        winner.fraudConfirmedAt === null &&
        Date.now() - winner.createdAt.getTime() < REFERRAL_RELOAD_WINDOW_MS
      ) {
        return NextResponse.json(
          { referralToken: newBrowserToken },
          { headers: CORS },
        );
      }
    }
    throw error;
  }

  if (throttled) rememberClick(throttled);

  return NextResponse.json({ referralToken }, { headers: CORS });
}
