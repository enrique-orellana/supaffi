// Destructive: runs db.click.deleteMany() / db.affiliateLink.deleteMany() /
// db.affiliate.deleteMany() / db.program.deleteMany() / db.merchant.deleteMany() /
// db.owner.deleteMany() before every test. Point DATABASE_URL at a disposable
// database, never a real deployment's data.
//
// AffiliateLink.code is globally unique across the instance, not scoped to a
// Merchant, so a code belonging to one Merchant resolves for any Host. The
// route used to enforce non-attribution across Merchants as part of the SQL
// row lookup; this branch moved it into an application-level comparison of
// the link's Affiliate.merchantId against the Host's resolved Merchant.id
// (src/app/api/track/route.ts). A regression there would silently attribute
// one Merchant's clicks to another and clicks become commissions, so this is
// the one guard on this endpoint that must not merge untested.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { markCommissionsPaid, PAYOUT_ERROR } from "@/lib/commission";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { GET } from "@/app/api/resolve/route";
import { REFERRAL_QUERY_PARAM } from "@/lib/referral";
import { resetTrackThrottle } from "@/lib/trackThrottle";
import { createCommissionUnlessSelfReferral } from "@/lib/worker/recordCommission";
import { getPayoutEligibility } from "@/lib/payoutEligibility";

let hasDatabase = false;
if (process.env.DATABASE_URL) {
  try {
    await db.$connect();
    hasDatabase = true;
  } catch {
    hasDatabase = false;
  }
}

if (!hasDatabase) {
  console.warn(
    "Skipping test/app/api/track/route.test.ts: no reachable DATABASE_URL. Set DATABASE_URL to a disposable database to run these tests.",
  );
}

async function seedMerchantWithAffiliate(tag: string) {
  const owner = await db.owner.create({
    data: { email: `track-route-${tag}-owner@example.com`, passwordHash: "x" },
  });
  const merchant = await db.merchant.create({
    data: {
      slug: crypto.randomUUID(),
      ownerId: owner.id,
      name: `Track Route ${tag}`,
      domain: `track-route-${tag}.example.com`,
      websiteUrl: `https://track-route-${tag}.example.com`,
    },
  });
  const program = await db.program.create({
    data: {
      slug: crypto.randomUUID(),
      merchantId: merchant.id,
      name: "Standard",
      defaultCommissionRate: "20.00",
      commissionDurationType: "FOREVER",
      attributionWindowDays: 60,
      holdingPeriodDays: 30,
    },
  });
  const affiliate = await db.affiliate.create({
    data: {
      merchantId: merchant.id,
      programId: program.id,
      email: `track-route-${tag}@example.com`,
      links: { create: { code: `track-route-${tag}-code`, isPrimary: true } },
    },
  });
  const link = await db.affiliateLink.findFirstOrThrow({
    where: { affiliateId: affiliate.id },
  });
  return { merchant, affiliate, link };
}

function requestFor(
  host: string,
  code: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    `http://${host}/api/resolve?${REFERRAL_QUERY_PARAM}=${code}`,
    {
      headers: { host, ...headers },
    },
  );
}

describe.skipIf(!hasDatabase)("GET /api/resolve", () => {
  beforeEach(async () => {
    resetTrackThrottle();
    await db.commission.deleteMany();
    await db.payout.deleteMany();
    await db.referredSubscription.deleteMany();
    await db.click.deleteMany();
    await db.retiredLinkCode.deleteMany();
    await db.affiliateLink.deleteMany();
    await db.affiliate.deleteMany();
    await db.program.deleteMany();
    await db.merchant.deleteMany();
    await db.owner.deleteMany();
  });

  afterAll(async () => {
    await db.commission.deleteMany();
    await db.payout.deleteMany();
    await db.referredSubscription.deleteMany();
    await db.click.deleteMany();
    await db.retiredLinkCode.deleteMany();
    await db.affiliateLink.deleteMany();
    await db.affiliate.deleteMany();
    await db.program.deleteMany();
    await db.merchant.deleteMany();
    await db.owner.deleteMany();
    await db.$disconnect();
  });

  it("404s and records no Click when the code's Merchant does not match the requesting Host's Merchant", async () => {
    const a = await seedMerchantWithAffiliate("a");
    const b = await seedMerchantWithAffiliate("b");

    // Merchant A's own code, requested on Merchant B's Host.
    const res = await GET(requestFor(b.merchant.domain, a.link.code));

    expect(res.status).toBe(404);
    expect(await db.click.count()).toBe(0);
  });

  it("attributes a click when the code and the Host belong to the same Merchant", async () => {
    const a = await seedMerchantWithAffiliate("a");
    await seedMerchantWithAffiliate("b"); // present to prove the match isn't accidental

    const res = await GET(requestFor(a.merchant.domain, a.link.code));

    expect(res.status).toBe(200);
    const clicks = await db.click.findMany();
    expect(clicks).toHaveLength(1);
    expect(clicks[0].affiliateId).toBe(a.affiliate.id);
    expect(clicks[0].linkId).toBe(a.link.id);
  });

  it("uses a browser-generated token as an idempotency key across reloads", async () => {
    const a = await seedMerchantWithAffiliate("reload");
    const token = crypto.randomUUID();
    const url = `${a.link.code}&token=${token}`;

    const first = await GET(requestFor(a.merchant.domain, url));
    expect(first.status).toBe(200);
    expect((await first.json()).referralToken).toBe(token);

    const reload = await GET(requestFor(a.merchant.domain, url));
    expect(reload.status).toBe(200);
    expect((await reload.json()).referralToken).toBe(token);
    expect(await db.click.count()).toBe(1);
  });

  it("accepts via for imported legacy links", async () => {
    const a = await seedMerchantWithAffiliate("via-legacy");
    await db.affiliateLink.update({
      where: { id: a.link.id },
      data: {
        importSourceIdentity: "legacy-import-via-legacy",
        legacyAliases: ["older-track-route-code"],
        legacyQueryParamAliases: ["via"],
      },
    });

    const response = await GET(
      new NextRequest(
        `http://${a.merchant.domain}/api/resolve?via=older-track-route-code`,
        { headers: { host: a.merchant.domain } },
      ),
    );

    expect(response.status).toBe(200);
    expect(await db.click.count()).toBe(1);
  });

  it("snapshots the affiliate's program terms on each new click", async () => {
    const a = await seedMerchantWithAffiliate("terms");
    await db.affiliateProgramTerms.create({
      data: {
        merchantId: a.affiliate.merchantId,
        affiliateId: a.affiliate.id,
        programId: a.affiliate.programId,
        customCommissionRate: "12.50",
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 8,
        attributionWindowDaysOverride: 14,
        holdingPeriodDaysOverride: 7,
      },
    });
    // Imported per-link settings are legacy data and must not affect new clicks.
    await db.affiliateLink.update({
      where: { id: a.link.id },
      data: {
        commissionRateOverride: "80.00",
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 1,
        attributionWindowDaysOverride: 1,
        holdingPeriodDaysOverride: 1,
      },
    });

    const response = await GET(requestFor(a.merchant.domain, a.link.code));
    const { referralToken } = await response.json();
    const click = await db.click.findUniqueOrThrow({
      where: { referralToken },
    });

    expect(click.commissionRateSnapshot?.toFixed(2)).toBe("12.50");
    expect(click.commissionDurationTypeSnapshot).toBe("FIXED_MONTHS");
    expect(click.commissionDurationMonthsSnapshot).toBe(8);
    expect(click.holdingPeriodDaysSnapshot).toBe(7);
    expect(
      click.expiresAt.getTime() - click.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000);
    expect(click.expiresAt.getTime() - click.createdAt.getTime()).toBeLessThan(
      14 * 24 * 60 * 60 * 1000 + 1000,
    );
  });

  it("keeps a full referral and payout flow scoped to each affiliate/program pair", async () => {
    const owner = await db.owner.create({
      data: {
        email: `track-route-lifecycle-owner-${crypto.randomUUID()}@example.com`,
        passwordHash: "x",
      },
    });
    const merchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId: owner.id,
        name: "Payout lifecycle",
        domain: `track-route-lifecycle-${crypto.randomUUID()}.example.com`,
        websiteUrl: "https://payout-lifecycle.example.com",
      },
    });
    const programA = await db.program.create({
      data: {
        slug: crypto.randomUUID(),
        merchantId: merchant.id,
        name: "Program A",
        defaultCommissionRate: "10.00",
        minimumPayoutAmount: "100.00",
        commissionDurationType: "FOREVER",
        attributionWindowDays: 60,
        holdingPeriodDays: 0,
      },
    });
    const affiliate = await db.affiliate.create({
      data: {
        merchantId: merchant.id,
        programId: programA.id,
        email: `track-route-lifecycle-${crypto.randomUUID()}@example.com`,
        links: { create: { code: crypto.randomUUID(), isPrimary: true } },
      },
    });
    const link = await db.affiliateLink.findFirstOrThrow({
      where: { affiliateId: affiliate.id },
    });
    await db.affiliateProgramTerms.create({
      data: {
        merchantId: merchant.id,
        affiliateId: affiliate.id,
        programId: programA.id,
        customCommissionRate: "20.00",
        holdingPeriodDaysOverride: 0,
        minimumPayoutAmountOverride: "25.00",
      },
    });

    const firstClickResponse = await GET(
      requestFor(merchant.domain, link.code),
    );
    expect(firstClickResponse.status).toBe(200);
    const firstToken = (await firstClickResponse.json()).referralToken;
    const firstClick = await db.click.findUniqueOrThrow({
      where: { referralToken: firstToken },
    });
    expect(firstClick.programId).toBe(programA.id);
    expect(firstClick.commissionRateSnapshot?.toFixed(2)).toBe("20.00");

    async function recordSale(
      clickId: string,
      paymentRef: string,
      amount: string,
    ) {
      expect(
        await createCommissionUnlessSelfReferral({
          data: {
            affiliateId: affiliate.id,
            clickId,
            stripePaymentRef: paymentRef,
            amount,
            grossAmount: amount,
            currency: "usd",
            status: COMMISSION_STATUS.PENDING,
            payableAt: new Date(Date.now() - 1_000),
          },
        }),
      ).toBe(true);
      return db.commission.findFirstOrThrow({
        where: { stripePaymentRef: paymentRef },
      });
    }

    const aFirst = await recordSale(firstClick.id, "lifecycle-a-1", "10.00");
    expect(aFirst.status).toBe(COMMISSION_STATUS.PENDING);
    const aSecond = await recordSale(firstClick.id, "lifecycle-a-2", "20.00");
    expect(aSecond.status).toBe(COMMISSION_STATUS.PAYABLE);
    const aGroup = await db.commission.findMany({
      where: { affiliateId: affiliate.id, programId: programA.id },
      orderBy: { stripePaymentRef: "asc" },
    });
    expect(aGroup.map((commission) => commission.status)).toEqual([
      COMMISSION_STATUS.PAYABLE,
      COMMISSION_STATUS.PAYABLE,
    ]);

    const programB = await db.program.create({
      data: {
        slug: crypto.randomUUID(),
        merchantId: merchant.id,
        name: "Program B",
        defaultCommissionRate: "5.00",
        minimumPayoutAmount: "200.00",
        commissionDurationType: "FOREVER",
        attributionWindowDays: 60,
        holdingPeriodDays: 0,
      },
    });
    await db.affiliateProgramTerms.create({
      data: {
        merchantId: merchant.id,
        affiliateId: affiliate.id,
        programId: programB.id,
        customCommissionRate: "30.00",
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 6,
        attributionWindowDaysOverride: 10,
        holdingPeriodDaysOverride: 0,
        minimumPayoutAmountOverride: "50.00",
      },
    });
    await db.affiliate.update({
      where: { id: affiliate.id },
      data: { programId: programB.id },
    });

    const oldProgramEligibility = await getPayoutEligibility(db, {
      merchantId: merchant.id,
      affiliateId: affiliate.id,
      programId: programA.id,
      currency: "usd",
    });
    expect(oldProgramEligibility).not.toBeNull();
    expect(oldProgramEligibility?.payable).toBe(true);
    expect(oldProgramEligibility?.minimum.toFixed(2)).toBe("25.00");
    expect(oldProgramEligibility?.eligibleBalance.toFixed(2)).toBe("30.00");

    const secondClickResponse = await GET(
      requestFor(merchant.domain, link.code),
    );
    expect(secondClickResponse.status).toBe(200);
    const secondToken = (await secondClickResponse.json()).referralToken;
    const secondClick = await db.click.findUniqueOrThrow({
      where: { referralToken: secondToken },
    });
    expect(secondClick.programId).toBe(programB.id);
    expect(secondClick.commissionRateSnapshot?.toFixed(2)).toBe("30.00");
    expect(secondClick.commissionDurationTypeSnapshot).toBe("FIXED_MONTHS");
    expect(secondClick.commissionDurationMonthsSnapshot).toBe(6);
    expect(
      secondClick.expiresAt.getTime() - secondClick.createdAt.getTime(),
    ).toBe(10 * 24 * 60 * 60 * 1000);

    const bFirst = await recordSale(secondClick.id, "lifecycle-b-1", "30.00");
    expect(bFirst.status).toBe(COMMISSION_STATUS.PENDING);
    const mixedAttempt = await markCommissionsPaid(
      owner.id,
      merchant.id,
      [
        { id: aGroup[0].id, amount: aGroup[0].amount.toFixed(2) },
        { id: bFirst.id, amount: bFirst.amount.toFixed(2) },
      ],
      new Date().toISOString(),
    );
    expect(mixedAttempt).toEqual({ error: PAYOUT_ERROR.MIXED_GROUP });
    expect(await db.payout.count()).toBe(0);

    const bSecond = await recordSale(secondClick.id, "lifecycle-b-2", "30.00");
    expect(bSecond.status).toBe(COMMISSION_STATUS.PAYABLE);
    const bGroup = await db.commission.findMany({
      where: { affiliateId: affiliate.id, programId: programB.id },
      orderBy: { stripePaymentRef: "asc" },
    });
    expect(bGroup.map((commission) => commission.status)).toEqual([
      COMMISSION_STATUS.PAYABLE,
      COMMISSION_STATUS.PAYABLE,
    ]);

    const paidA = await markCommissionsPaid(
      owner.id,
      merchant.id,
      aGroup.map((commission) => ({
        id: commission.id,
        amount: commission.amount.toFixed(2),
      })),
      new Date().toISOString(),
    );
    expect(paidA).toMatchObject({ count: 2 });
    const paidB = await markCommissionsPaid(
      owner.id,
      merchant.id,
      bGroup.map((commission) => ({
        id: commission.id,
        amount: commission.amount.toFixed(2),
      })),
      new Date().toISOString(),
    );
    expect(paidB).toMatchObject({ count: 2 });

    const payouts = await db.payout.findMany({
      where: { merchantId: merchant.id },
      orderBy: { programId: "asc" },
    });
    expect(payouts).toHaveLength(2);
    expect(
      payouts.map((payout) => [payout.programId, payout.total.toFixed(2)]),
    ).toEqual(
      [
        [programA.id, "30.00"],
        [programB.id, "60.00"],
      ].sort(([programIdA], [programIdB]) =>
        programIdA.localeCompare(programIdB),
      ),
    );
    expect(
      await db.commission.count({
        where: {
          affiliateId: affiliate.id,
          status: COMMISSION_STATUS.PAID,
        },
      }),
    ).toBe(4);
  });

  it("gives two visitors behind one address their own clicks", async () => {
    const a = await seedMerchantWithAffiliate("a");
    const office = { "x-forwarded-for": "198.51.100.1, 203.0.113.7" };

    const first = await (
      await GET(requestFor(a.merchant.domain, a.link.code, office))
    ).json();
    const second = await (
      await GET(requestFor(a.merchant.domain, a.link.code, office))
    ).json();

    expect(second.referralToken).not.toBe(first.referralToken);
    expect(await db.click.count()).toBe(2);
  });

  it("hands a browser that sends back its live token that same token instead of a second click", async () => {
    const a = await seedMerchantWithAffiliate("a");

    const first = await (
      await GET(requestFor(a.merchant.domain, a.link.code))
    ).json();
    const again = await (
      await GET(
        requestFor(
          a.merchant.domain,
          `${a.link.code}&token=${first.referralToken}`,
        ),
      )
    ).json();

    expect(again.referralToken).toBe(first.referralToken);
    expect(await db.click.count()).toBe(1);
  });

  it("starts a new click when the token sent back is from an earlier visit, not a reload", async () => {
    const a = await seedMerchantWithAffiliate("a");

    const first = await (
      await GET(requestFor(a.merchant.domain, a.link.code))
    ).json();
    await db.click.update({
      where: { referralToken: first.referralToken },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    const later = await (
      await GET(
        requestFor(
          a.merchant.domain,
          `${a.link.code}&token=${first.referralToken}`,
        ),
      )
    ).json();

    expect(later.referralToken).not.toBe(first.referralToken);
    expect(await db.click.count()).toBe(2);
  });

  it("never hands back a click confirmed as a self referral", async () => {
    const a = await seedMerchantWithAffiliate("a");

    const first = await (
      await GET(requestFor(a.merchant.domain, a.link.code))
    ).json();
    await db.click.update({
      where: { referralToken: first.referralToken },
      data: { fraudConfirmedAt: new Date() },
    });
    const again = await (
      await GET(
        requestFor(
          a.merchant.domain,
          `${a.link.code}&token=${first.referralToken}`,
        ),
      )
    ).json();

    expect(again.referralToken).not.toBe(first.referralToken);
  });

  it("starts a new click when the token sent back belongs to another link", async () => {
    const a = await seedMerchantWithAffiliate("a");
    const other = await db.affiliateLink.create({
      data: {
        code: "track-route-a-second",
        affiliateId: a.affiliate.id,
        merchantId: a.merchant.id,
      },
    });

    const first = await (
      await GET(requestFor(a.merchant.domain, a.link.code))
    ).json();
    const next = await (
      await GET(
        requestFor(
          a.merchant.domain,
          `${other.code}&token=${first.referralToken}`,
        ),
      )
    ).json();

    expect(next.referralToken).not.toBe(first.referralToken);
    expect(await db.click.count()).toBe(2);
  });

  it("does not attribute a code its affiliate retired", async () => {
    const a = await seedMerchantWithAffiliate("a");
    await db.retiredLinkCode.create({
      data: {
        code: "track-route-a-old",
        affiliateId: a.affiliate.id,
        merchantId: a.merchant.id,
      },
    });

    const res = await GET(requestFor(a.merchant.domain, "track-route-a-old"));

    expect(res.status).toBe(404);
    expect(await db.click.count()).toBe(0);
  });
});
