import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { CurrencyTotal } from "@/lib/analytics";
import { SqlSchema } from "@/lib/sqlSchema";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { validateLinkInput as validateSharedLinkInput } from "@/lib/affiliateLinkShared";
import type { LinkInput } from "@/lib/affiliateLinkShared";

export { linkUrl, validateLinkInput } from "@/lib/affiliateLinkShared";
export type { LinkInput, ValidatedLink } from "@/lib/affiliateLinkShared";

export type AffiliateLinkRow = {
  id: string;
  code: string;
  destinationPath: string | null;
  isPrimary: boolean;
};

/**
 * The link created at signup.
 *
 * Every Affiliate has exactly one, it cannot be deleted, and it is the code the
 * Merchant's own dashboard shows. Returns null only for an Affiliate id that
 * does not exist, which callers already treat as "log in again".
 */
export async function getPrimaryLink(
  affiliateId: string,
): Promise<AffiliateLinkRow | null> {
  const link = await db.affiliateLink.findFirst({
    where: { affiliateId, isPrimary: true },
    select: { id: true, code: true, destinationPath: true, isPrimary: true },
  });
  return link ?? null;
}

/** Every link an Affiliate has, primary first, then oldest first. */
export async function listLinks(
  affiliateId: string,
): Promise<AffiliateLinkRow[]> {
  return db.affiliateLink.findMany({
    where: { affiliateId },
    select: { id: true, code: true, destinationPath: true, isPrimary: true },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

export type OwnerAffiliateLinkTerms = {
  id: string;
  commissionRateOverride: string | null;
  commissionDurationTypeOverride:
    import("@prisma/client").CommissionDurationType | null;
  commissionDurationMonthsOverride: number | null;
  attributionWindowDaysOverride: number | null;
  holdingPeriodDaysOverride: number | null;
};

/** Per-code settings for one Owner's affiliate, kept out of the Affiliate dashboard payload. */
export async function listOwnerLinkTerms(
  ownerId: string,
  merchantId: string,
  affiliateId: string,
): Promise<OwnerAffiliateLinkTerms[]> {
  const links = await db.affiliateLink.findMany({
    where: { merchantId, affiliateId, affiliate: { merchant: { ownerId } } },
    select: {
      id: true,
      commissionRateOverride: true,
      commissionDurationTypeOverride: true,
      commissionDurationMonthsOverride: true,
      attributionWindowDaysOverride: true,
      holdingPeriodDaysOverride: true,
    },
  });
  return links.map((link) => ({
    ...link,
    commissionRateOverride: link.commissionRateOverride?.toString() ?? null,
  }));
}

/**
 * A ceiling, not a product rule. Links are free to create and each one is a
 * Merchant-unique code, so an unbounded allowance is a way to exhaust the code
 * space for everyone else on the instance.
 */
export const MAX_LINKS_PER_AFFILIATE = 20;

const CODE_TAKEN = "That code is already taken. Try another.";
const LINK_GONE = "That link no longer exists.";

/**
 * How many codes one Affiliate can have retired. Retired codes are held for
 * good within their Merchant unless reclaimed by that same Affiliate, so without a ceiling renaming a
 * link over and over would let one Affiliate claim any number of names.
 */
export const MAX_RETIRED_CODES_PER_AFFILIATE = 50;
const TOO_MANY_RETIRED =
  "You have changed or deleted too many links. Contact the program owner.";

/**
 * Whether retiring one more code would pass the ceiling. `reclaimed` is a code
 * this change takes back from the Affiliate's own retired ones, which frees a
 * place. Locks the Affiliate row first, so parallel renames count one at a time.
 */
async function retiredCodesFull(
  tx: Prisma.TransactionClient,
  affiliateId: string,
  reclaimed: string | null,
): Promise<boolean> {
  await tx.$queryRaw(Prisma.sql`
    SELECT ${SqlSchema.tables.Affiliate.id}
    FROM ${SqlSchema.tables.Affiliate.name}
    WHERE ${SqlSchema.tables.Affiliate.id} = ${affiliateId}
    FOR UPDATE
  `);
  const count = await tx.retiredLinkCode.count({
    where: { affiliateId, ...(reclaimed ? { code: { not: reclaimed } } : {}) },
  });
  return count >= MAX_RETIRED_CODES_PER_AFFILIATE;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Serializes everything that claims or retires these codes until the
 * transaction ends. Without it, a signup can check that a code is not retired
 * while a rename is retiring it, and both commit. Locks are taken in sorted
 * order so two renames swapping codes cannot deadlock.
 */
export async function lockLinkCodes(
  tx: Prisma.TransactionClient,
  merchantId: string,
  codes: string[],
): Promise<void> {
  const sorted = [...new Set(codes.map((code) => code.toLowerCase()))].sort();
  for (let offset = 0; offset < sorted.length; offset += 1000) {
    const chunk = sorted.slice(offset, offset + 1000);
    await tx.$queryRaw`
      WITH ordered_codes AS MATERIALIZED (
        SELECT code FROM unnest(ARRAY[${Prisma.join(chunk)}]::text[]) AS input_codes(code)
        ORDER BY lower(code)
      )
      SELECT pg_advisory_xact_lock(hashtextextended('link-code:' || ${merchantId} || ':' || lower(ordered_codes.code), 0)) IS NULL AS locked
      FROM ordered_codes
      ORDER BY lower(ordered_codes.code)`;
  }
}

export async function isLinkCodeTaken(
  tx: Prisma.TransactionClient,
  merchantId: string,
  code: string,
  excludeLinkId?: string,
  affiliateId?: string | null,
): Promise<boolean> {
  const normalized = code.toLowerCase();
  const [link, retired] = await Promise.all([
    tx.affiliateLink.findFirst({
      where: {
        merchantId,
        ...(excludeLinkId ? { id: { not: excludeLinkId } } : {}),
        OR: [{ code: normalized }, { legacyAliases: { has: normalized } }],
      },
      select: { id: true },
    }),
    tx.retiredLinkCode.findUnique({
      where: { merchantId_code: { merchantId, code: normalized } },
      select: { id: true, affiliateId: true },
    }),
  ]);
  return (
    link !== null || (retired !== null && retired.affiliateId !== affiliateId)
  );
}

async function retireCode(
  tx: Prisma.TransactionClient,
  code: string,
  affiliateId: string,
  merchantId: string,
): Promise<void> {
  await retireCodes(tx, [code], affiliateId, merchantId);
}

async function retireCodes(
  tx: Prisma.TransactionClient,
  codes: string[],
  affiliateId: string,
  merchantId: string,
): Promise<void> {
  const retiredAt = new Date();
  const uniqueCodes = [...new Set(codes)];
  for (let offset = 0; offset < uniqueCodes.length; offset += 500) {
    await tx.retiredLinkCode.createMany({
      data: uniqueCodes
        .slice(offset, offset + 500)
        .map((code) => ({ code, affiliateId, merchantId, retiredAt })),
      skipDuplicates: true,
    });
  }
}

export async function createLink(
  affiliateId: string,
  input: LinkInput,
): Promise<{ error: string } | { id: string }> {
  const validated = validateSharedLinkInput(input);
  if (validated.error !== null) return { error: validated.error };
  const { code, destinationPath } = validated;

  try {
    return await db.$transaction(async (tx) => {
      // Locks the Affiliate row first, so parallel requests count one at a
      // time. A count followed by a separate insert let a burst of them all
      // see room for one more and all insert.
      const locked = await tx.$queryRaw<
        { id: string; merchantId: string }[]
      >(Prisma.sql`
        SELECT ${SqlSchema.tables.Affiliate.id}, ${SqlSchema.tables.Affiliate.merchantId}
        FROM ${SqlSchema.tables.Affiliate.name}
        WHERE ${SqlSchema.tables.Affiliate.id} = ${affiliateId}
        FOR UPDATE
      `);
      if (locked.length === 0) return { error: LINK_GONE };

      const count = await tx.affiliateLink.count({ where: { affiliateId } });
      if (count >= MAX_LINKS_PER_AFFILIATE) {
        return {
          error: `You can have up to ${MAX_LINKS_PER_AFFILIATE} links. Delete one to add another.`,
        };
      }

      const merchantId = locked[0].merchantId;
      await lockLinkCodes(tx, merchantId, [code]);
      if (await isLinkCodeTaken(tx, merchantId, code, undefined, affiliateId))
        return { error: CODE_TAKEN };

      const created = await tx.affiliateLink.create({
        data: {
          merchantId,
          affiliateId,
          code,
          destinationPath,
          isPrimary: false,
        },
        select: { id: true },
      });
      await tx.retiredLinkCode.deleteMany({
        where: { merchantId, code, affiliateId },
      });
      // Taking back one's own retired code makes it live again.
      return { id: created.id };
    });
  } catch (err) {
    // A live code is still decided by the unique constraint, and this is
    // where that answer is read.
    if (isUniqueViolation(err)) return { error: CODE_TAKEN };
    throw err;
  }
}

export async function updateLink(
  affiliateId: string,
  linkId: string,
  input: LinkInput,
): Promise<{ error: string } | { ok: true }> {
  const validated = validateSharedLinkInput(input);
  if (validated.error !== null) return { error: validated.error };
  const { code, destinationPath } = validated;

  try {
    return await db.$transaction(async (tx) => {
      // Scoped by affiliateId, so one Affiliate cannot rename another's link
      // into their own.
      const link = await tx.affiliateLink.findFirst({
        where: { id: linkId, affiliateId },
        select: { code: true, affiliate: { select: { merchantId: true } } },
      });
      if (!link) return { error: LINK_GONE };

      const renamed = link.code !== code;
      if (renamed) {
        if (await retiredCodesFull(tx, affiliateId, code))
          return { error: TOO_MANY_RETIRED };
        await lockLinkCodes(tx, link.affiliate.merchantId, [link.code, code]);
        if (
          await isLinkCodeTaken(
            tx,
            link.affiliate.merchantId,
            code,
            linkId,
            affiliateId,
          )
        )
          return { error: CODE_TAKEN };
      }

      // Matched on the code read above as well, so a concurrent rename of the
      // same link cannot leave a different code retired than the one replaced.
      const result = await tx.affiliateLink.updateMany({
        where: { id: linkId, affiliateId, code: link.code },
        data: { code, destinationPath },
      });
      if (result.count === 0) return { error: LINK_GONE };

      if (renamed) {
        // The old code stays with this Affiliate for good, since links carrying
        // it are already out in the world.
        await retireCode(tx, link.code, affiliateId, link.affiliate.merchantId);
        await tx.retiredLinkCode.deleteMany({
          where: { merchantId: link.affiliate.merchantId, code, affiliateId },
        });
      }
      return { ok: true as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: CODE_TAKEN };
    throw err;
  }
}

export async function deleteLink(
  affiliateId: string,
  linkId: string,
): Promise<{ error: string } | { ok: true }> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string; merchantId: string }[]
    >(Prisma.sql`
      SELECT ${SqlSchema.tables.Affiliate.id}, ${SqlSchema.tables.Affiliate.merchantId}
      FROM ${SqlSchema.tables.Affiliate.name}
      WHERE ${SqlSchema.tables.Affiliate.id} = ${affiliateId}
      FOR UPDATE
    `);
    if (locked.length === 0) return { error: LINK_GONE };
    const link = await tx.affiliateLink.findFirst({
      where: { id: linkId, affiliateId },
      select: {
        code: true,
        legacyAliases: true,
        importSourceIdentity: true,
        isPrimary: true,
      },
    });
    if (!link) return { error: LINK_GONE };
    if (link.isPrimary) return { error: "Your signup link cannot be deleted." };
    const merchantId = locked[0]!.merchantId;
    const codesToRetire = [...new Set([link.code, ...link.legacyAliases])];
    if (link.importSourceIdentity === null) {
      const retiredCount = await tx.retiredLinkCode.count({
        where: { affiliateId, merchantId },
      });
      if (retiredCount + codesToRetire.length > MAX_RETIRED_CODES_PER_AFFILIATE)
        return { error: TOO_MANY_RETIRED };
    }

    await lockLinkCodes(tx, merchantId, codesToRetire);
    // Click.linkId is ON DELETE SET NULL, so the clicks and every Commission
    // behind them survive. Only the per-link attribution is lost, which is the
    // honest outcome: the link is gone.
    const deleted = await tx.affiliateLink.deleteMany({
      where: { id: linkId, affiliateId, code: link.code },
    });
    if (deleted.count === 0) return { error: LINK_GONE };
    await retireCodes(tx, codesToRetire, affiliateId, merchantId);
    return { ok: true as const };
  });
}

export type AffiliateLinkStats = AffiliateLinkRow & {
  clicks: number;
  conversions: number;
  earned: CurrencyTotal[];
};

/**
 * Every link with what it has produced. Earnings exclude VOIDED: a refunded
 * sale is not something the Affiliate earned, and showing it would inflate
 * every link's total permanently.
 */
export async function listLinksWithStats(
  affiliateId: string,
): Promise<AffiliateLinkStats[]> {
  const links = await listLinks(affiliateId);
  if (links.length === 0) return [];
  const ids = links.map((l) => l.id);

  const [clickGroups, commissionRows] = await Promise.all([
    db.click.groupBy({
      by: ["linkId"],
      where: { linkId: { in: ids } },
      _count: { _all: true },
    }),
    // An unpaid adjustment row an older version left behind counts nowhere; a
    // paid one is history and stays in, same rule as every other paid or
    // earned figure.
    db.commission.findMany({
      where: {
        click: { linkId: { in: ids } },
        status: { not: COMMISSION_STATUS.VOIDED },
        OR: [{ status: COMMISSION_STATUS.PAID }, { adjustsCommissionId: null }],
      },
      select: {
        amount: true,
        currency: true,
        click: { select: { linkId: true } },
      },
    }),
  ]);

  const clicksByLink = new Map(
    clickGroups.map((g) => [g.linkId, g._count._all]),
  );
  const totals = new Map<string, Map<string, Prisma.Decimal>>();
  const conversions = new Map<string, number>();
  for (const row of commissionRows) {
    const linkId = row.click.linkId;
    if (!linkId) continue;
    conversions.set(linkId, (conversions.get(linkId) ?? 0) + 1);
    const byCurrency = totals.get(linkId) ?? new Map<string, Prisma.Decimal>();
    byCurrency.set(
      row.currency,
      (byCurrency.get(row.currency) ?? new Prisma.Decimal(0)).add(row.amount),
    );
    totals.set(linkId, byCurrency);
  }

  return links.map((link) => ({
    ...link,
    clicks: clicksByLink.get(link.id) ?? 0,
    conversions: conversions.get(link.id) ?? 0,
    earned: [...(totals.get(link.id) ?? new Map())]
      .map(([currency, total]) => ({ currency, total: total.toFixed(2) }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }));
}
