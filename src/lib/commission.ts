import { db } from "@/lib/db";
import { currencyMinorUnitExponent } from "@/lib/currency";
import { Prisma } from "@prisma/client";
import { SqlSchema } from "@/lib/sqlSchema";
import {
  COMMISSION_STATUS,
  COMMISSION_STATUSES,
  UNPAID_COMMISSION_STATUSES,
} from "@/lib/commissionStatus";
import type { CommissionStatus } from "@/lib/commissionStatus";
import {
  getPayoutEligibility,
  listPayoutSnapshotCommissions,
  lockCommissionPayoutEligibilityGroup,
  lockPayoutEligibilityGroup,
  lockPayoutEligibilityProgram,
  recalculatePayoutEligibility,
  type PayoutEligibilityGroup,
} from "@/lib/payoutEligibility";

export { COMMISSION_STATUS, COMMISSION_STATUSES } from "@/lib/commissionStatus";
export type { CommissionStatus } from "@/lib/commissionStatus";

async function assertMerchantOwnership(
  ownerId: string,
  merchantId: string,
): Promise<void> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { id: true },
  });
  if (!merchant) {
    throw new Error("Merchant not found");
  }
}

export type CommissionFilters = {
  /** Null means every status. */
  status: CommissionStatus | null;
  affiliateId: string | null;
  currency: string | null;
  /** Matches a Stripe payment reference, or an affiliate's name or email. */
  query: string | null;
  /** Narrows a payout group to the Program it belongs to. */
  programId?: string | null;
  /** Narrows paid history to one recorded payout. */
  payoutId?: string | null;
  /** Keeps only mature, clear, unadjusted commissions eligible for payout. */
  payoutGroup?: boolean;
};

export type CommissionRow = {
  id: string;
  amount: string;
  currency: string;
  status: CommissionStatus;
  createdAt: Date;
  payableAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
  flagReason: string | null;
  voidReason: string | null;
  /** What this commission was before a partial refund reduced it. Null when unchanged. */
  grossAmount: string | null;
  /** What the customer paid for this sale. Null on rows older than the column. */
  saleAmount: string | null;
  /** Provider fee removed before the affiliate rate was applied. */
  providerFeeAmount?: string | null;
  /** Effective processor fee rate captured when this commission was earned. */
  providerFeePercent?: string | null;
  providerFeeSource?: "ACTUAL" | "FALLBACK" | null;
  stripePaymentRef: string | null;
  paymentRecord: {
    provider: string;
    paymentRef: string | null;
    checkoutRef: string | null;
    saleAmount: string;
    saleCurrency: string;
    cryptoAmount: string | null;
    cryptoCurrency: string | null;
    cryptoNetwork: string | null;
  } | null;
  affiliateId: string;
  affiliateName: string | null;
  affiliateEmail: string;
  /** A refund adjustment row an older version wrote. None are written any more. */
  isAdjustment: boolean;
  /** Unpaid and held back from payment by an open dispute. */
  disputed: boolean;
  payoutHold: {
    eligibleBalance: string;
    minimum: string;
    remaining: string;
  } | null;
  payoutRecord: {
    id: string;
    total: string;
    currency: string;
    paidAt: Date;
    isException: boolean;
  } | null;
  /**
   * The click this sale was attributed to, the link it arrived through, and
   * whether the Owner already confirmed that referral as a self referral.
   */
  click: {
    at: Date;
    commissionRateSnapshot?: string | null;
    linkCode: string | null;
    destinationPath: string | null;
    selfReferralConfirmed: boolean;
  };
};

export const COMMISSIONS_PAGE_SIZE = 25;

function whereFor(merchantId: string, filters: CommissionFilters) {
  const query = filters.query?.trim();

  return {
    affiliate: {
      merchantId,
      ...(filters.affiliateId ? { id: filters.affiliateId } : {}),
    },
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.status === COMMISSION_STATUS.PAYABLE
      ? { checkoutConflictHeldAt: null }
      : {}),
    ...(filters.currency ? { currency: filters.currency } : {}),
    ...(filters.programId ? { programId: filters.programId } : {}),
    ...(filters.payoutId ? { payoutId: filters.payoutId } : {}),
    ...(filters.payoutGroup && !filters.payoutId
      ? {
          adjustsCommissionId: null,
          amount: { gt: 0 },
          disputeOpenedAt: null,
          checkoutConflictHeldAt: null,
          flagReason: null,
          payoutId: null,
          payableAt: { lte: new Date() },
        }
      : {}),
    ...(query
      ? {
          OR: [
            {
              stripePaymentRef: {
                contains: query,
                mode: "insensitive" as const,
              },
            },
            {
              affiliate: {
                merchantId,
                email: { contains: query, mode: "insensitive" as const },
              },
            },
            {
              affiliate: {
                merchantId,
                name: { contains: query, mode: "insensitive" as const },
              },
            },
          ],
        }
      : {}),
  };
}

/**
 * One ledger for every commission, whatever state it is in.
 *
 * There is no separate payable view and no separate flagged view. Splitting
 * them meant a commission the Owner had just been told about was invisible
 * until its Holding Period expired, and it took two paginated screens to
 * answer "what does this affiliate have outstanding".
 */
export async function listCommissions(
  ownerId: string,
  merchantId: string,
  filters: CommissionFilters,
  { page, pageSize }: { page: number; pageSize: number },
): Promise<{ rows: CommissionRow[]; total: number }> {
  await assertMerchantOwnership(ownerId, merchantId);

  const where = whereFor(merchantId, filters);

  const [total, rows] = await Promise.all([
    db.commission.count({ where }),
    db.commission.findMany({
      where,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        payableAt: true,
        paidAt: true,
        voidedAt: true,
        flagReason: true,
        voidReason: true,
        grossAmount: true,
        saleAmount: true,
        providerFeeAmount: true,
        providerFeePercent: true,
        providerFeeSource: true,
        stripePaymentRef: true,
        paymentRecord: {
          select: {
            provider: true,
            paymentRef: true,
            checkoutRef: true,
            saleAmount: true,
            saleCurrency: true,
            providerFeeAmount: true,
            providerFeeSource: true,
            cryptoAmount: true,
            cryptoCurrency: true,
            cryptoNetwork: true,
          },
        },
        adjustsCommissionId: true,
        disputeOpenedAt: true,
        checkoutConflictHeldAt: true,
        payoutId: true,
        programId: true,
        payout: {
          select: {
            id: true,
            total: true,
            currency: true,
            paidAt: true,
            isException: true,
          },
        },
        affiliate: { select: { id: true, name: true, email: true } },
        click: {
          select: {
            createdAt: true,
            commissionRateSnapshot: true,
            fraudConfirmedAt: true,
            // Nullable: deleting a link leaves its clicks behind, and
            // attribution reads the affiliate, not the link.
            link: { select: { code: true, destinationPath: true } },
          },
        },
      },
      // Newest first: the ledger is read to find out what just happened far
      // more often than to audit the beginning of time. On the payable tab
      // the sales come before the refund adjustments against them, which
      // are recent by nature and otherwise filled the first page.
      orderBy:
        filters.status === COMMISSION_STATUS.PAYABLE
          ? [
              { adjustsCommissionId: { sort: "asc", nulls: "first" } },
              { createdAt: "desc" },
            ]
          : { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const now = new Date();
  const payoutGroups = new Map<string, PayoutEligibilityGroup>();
  for (const commission of rows) {
    if (
      commission.status !== COMMISSION_STATUS.PENDING ||
      commission.payableAt > now ||
      commission.adjustsCommissionId !== null ||
      commission.amount.lte(0) ||
      commission.flagReason !== null ||
      commission.disputeOpenedAt !== null ||
      commission.checkoutConflictHeldAt !== null ||
      commission.payoutId !== null ||
      !commission.programId
    ) {
      continue;
    }
    const group: PayoutEligibilityGroup = {
      merchantId,
      affiliateId: commission.affiliate.id,
      programId: commission.programId,
      currency: commission.currency,
    };
    payoutGroups.set(
      `${group.affiliateId}:${group.programId}:${group.currency}`,
      group,
    );
  }
  const eligibilityEntries = await Promise.all(
    [...payoutGroups].map(
      async ([key, group]) =>
        [key, await getPayoutEligibility(db, group, now)] as const,
    ),
  );
  const eligibilityByGroup = new Map(eligibilityEntries);

  return {
    total,
    rows: rows.map((c) => ({
      id: c.id,
      amount: c.amount.toFixed(2),
      currency: c.currency,
      status: c.status as CommissionStatus,
      createdAt: c.createdAt,
      payableAt: c.payableAt,
      paidAt: c.paidAt,
      voidedAt: c.voidedAt,
      flagReason: c.flagReason,
      voidReason: c.voidReason,
      grossAmount: c.grossAmount ? c.grossAmount.toFixed(2) : null,
      saleAmount: c.saleAmount ? c.saleAmount.toFixed(2) : null,
      providerFeeAmount:
        (c.paymentRecord?.providerFeeAmount ?? c.providerFeeAmount)?.toFixed(
          currencyMinorUnitExponent(c.currency),
        ) ??
        null,
      providerFeePercent:
        c.providerFeePercent?.toFixed(2) ??
        (c.paymentRecord?.providerFeeAmount &&
        c.paymentRecord.saleAmount.gt(0)
          ? c.paymentRecord.providerFeeAmount
              .mul(100)
              .div(c.paymentRecord.saleAmount)
              .toFixed(2)
          : null),
      providerFeeSource:
        c.paymentRecord?.providerFeeSource ?? c.providerFeeSource,
      stripePaymentRef: c.stripePaymentRef,
      paymentRecord: c.paymentRecord
        ? {
            provider: c.paymentRecord.provider,
            paymentRef: c.paymentRecord.paymentRef,
            checkoutRef: c.paymentRecord.checkoutRef,
            saleAmount: c.paymentRecord.saleAmount.toFixed(2),
            saleCurrency: c.paymentRecord.saleCurrency,
            cryptoAmount: c.paymentRecord.cryptoAmount?.toString() ?? null,
            cryptoCurrency: c.paymentRecord.cryptoCurrency,
            cryptoNetwork: c.paymentRecord.cryptoNetwork,
          }
        : null,
      affiliateId: c.affiliate.id,
      affiliateName: c.affiliate.name,
      affiliateEmail: c.affiliate.email,
      isAdjustment: c.adjustsCommissionId !== null,
      // A voided or paid row can keep the date a dispute began; only an unpaid
      // one is still held by it.
      disputed:
        c.disputeOpenedAt !== null &&
        UNPAID_COMMISSION_STATUSES.includes(c.status),
      payoutHold: (() => {
        const eligibility = eligibilityByGroup.get(
          `${c.affiliate.id}:${c.programId}:${c.currency}`,
        );
        return eligibility && !eligibility.payable
          ? {
              eligibleBalance: eligibility.eligibleBalance.toFixed(2),
              minimum: eligibility.minimum.toFixed(2),
              remaining: Prisma.Decimal.max(
                eligibility.minimum.sub(eligibility.eligibleBalance),
                new Prisma.Decimal(0),
              ).toFixed(2),
            }
          : null;
      })(),
      payoutRecord: c.payout
        ? {
            id: c.payout.id,
            total: c.payout.total.toFixed(2),
            currency: c.payout.currency,
            paidAt: c.payout.paidAt,
            isException: c.payout.isException,
          }
        : null,
      click: {
        at: c.click.createdAt,
        commissionRateSnapshot:
          c.click.commissionRateSnapshot?.toFixed(2) ?? null,
        linkCode: c.click.link?.code ?? null,
        destinationPath: c.click.link?.destinationPath ?? null,
        selfReferralConfirmed: c.click.fraudConfirmedAt !== null,
      },
    })),
  };
}

export type StatusTotal = {
  status: CommissionStatus;
  count: number;
  /** One entry per currency, since amounts are never converted. */
  amounts: { currency: string; total: string }[];
};

/**
 * Count and money per status, across the whole Merchant.
 *
 * Deliberately not filtered by the current view: these double as the status
 * filter, so they have to say what is there, not what is showing.
 */
export async function getCommissionTotals(
  ownerId: string,
  merchantId: string,
): Promise<StatusTotal[]> {
  await assertMerchantOwnership(ownerId, merchantId);

  const grouped = await db.commission.groupBy({
    by: ["status", "currency"],
    where: { affiliate: { merchantId } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  return COMMISSION_STATUSES.map((status) => {
    const forStatus = grouped.filter((g) => g.status === status);
    return {
      status,
      count: forStatus.reduce((sum, g) => sum + g._count._all, 0),
      amounts: forStatus
        .map((g) => ({
          currency: g.currency,
          total: (g._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    };
  });
}

/** Everything the filter bar offers, drawn from what this Merchant actually has. */
export async function getCommissionFilterOptions(
  ownerId: string,
  merchantId: string,
): Promise<{
  affiliates: { id: string; name: string | null; email: string }[];
  currencies: string[];
}> {
  await assertMerchantOwnership(ownerId, merchantId);

  const [affiliates, currencies] = await Promise.all([
    db.affiliate.findMany({
      where: { merchantId, commissions: { some: {} } },
      select: { id: true, name: true, email: true },
      orderBy: { email: "asc" },
    }),
    db.commission.groupBy({
      by: ["currency"],
      where: { affiliate: { merchantId } },
      orderBy: { currency: "asc" },
    }),
  ]);

  return { affiliates, currencies: currencies.map((c) => c.currency) };
}

/** One commission as a page showed it: its id and its amount as rendered, two decimals. */
export type ShownCommission = { id: string; amount: string };

export type MarkPaidResult =
  { count: number; payoutId: string } | { error: PayoutErrorCode };

export const PAYOUT_ERROR = {
  EMPTY: "empty",
  INVALID: "invalid",
  MIXED_GROUP: "mixed",
  STALE_PAGE: "stale",
  INELIGIBLE: "ineligible",
  BELOW_MINIMUM: "below_minimum",
  CLOSEOUT: "closeout",
  CLOSEOUT_REASON: "closeout_reason",
} as const;

export type PayoutErrorCode = (typeof PAYOUT_ERROR)[keyof typeof PAYOUT_ERROR];

/** Every amount a page renders is `Decimal.toFixed(2)` of a positive commission. */
const TWO_DECIMALS = /^\d+\.\d{2}$/;

/** Bound a payout's server-action payload while covering large earned groups. */
export const MAX_SHOWN = 10_000;

/**
 * How old a page may be when it records a payout. Long enough to send the
 * money from a bank and come back. Past it, a refund that landed meanwhile
 * would be written back as paid at its full amount, so the payout is refused
 * and the page shown again with the refund.
 */
const MAX_PAGE_AGE_MS = 60 * 60 * 1000;
export const STALE_PAGE =
  "That payout was not recorded because the page was over an hour old. Check the amounts and pay again.";

class PayoutWriteConflict extends Error {}

/** Record exactly one completed external payout for one Affiliate/Program/currency group. */
export async function markCommissionsPaid(
  ownerId: string,
  merchantId: string,
  shown: ShownCommission[],
  renderedAt: string,
  note: string | null = null,
  exceptionReason: string | null = null,
): Promise<MarkPaidResult> {
  await assertMerchantOwnership(ownerId, merchantId);

  if (!Array.isArray(shown) || shown.length === 0) {
    return { error: PAYOUT_ERROR.EMPTY };
  }
  if (shown.length > MAX_SHOWN) return { error: PAYOUT_ERROR.INVALID };
  if (note !== null && (typeof note !== "string" || note.length > 200)) {
    return { error: PAYOUT_ERROR.INVALID };
  }
  if (
    exceptionReason !== null &&
    (typeof exceptionReason !== "string" ||
      exceptionReason.trim().length === 0 ||
      exceptionReason.length > 500)
  ) {
    return { error: PAYOUT_ERROR.CLOSEOUT_REASON };
  }
  const payoutNote = note?.trim() || null;
  const closeoutReason = exceptionReason?.trim() || null;
  const amounts = new Map<string, Prisma.Decimal>();
  for (const entry of shown) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.amount !== "string" ||
      !TWO_DECIMALS.test(entry.amount) ||
      amounts.has(entry.id)
    ) {
      return { error: PAYOUT_ERROR.INVALID };
    }
    const amount = new Prisma.Decimal(entry.amount);
    if (amount.lte(0)) return { error: PAYOUT_ERROR.INVALID };
    amounts.set(entry.id, amount);
  }

  const now = new Date();
  const loadedAt =
    typeof renderedAt === "string" ? new Date(renderedAt) : new Date(NaN);
  if (Number.isNaN(loadedAt.getTime()) || loadedAt.getTime() > now.getTime()) {
    return { error: PAYOUT_ERROR.INVALID };
  }
  if (now.getTime() - loadedAt.getTime() > MAX_PAGE_AGE_MS) {
    return { error: PAYOUT_ERROR.STALE_PAGE };
  }

  const ids = [...amounts.keys()];
  try {
    return await db.$transaction(async (tx): Promise<MarkPaidResult> => {
      const initialRows = await tx.commission.findMany({
        where: { id: { in: ids }, merchantId, affiliate: { merchantId } },
        select: {
          id: true,
          merchantId: true,
          affiliateId: true,
          programId: true,
          currency: true,
        },
      });
      if (initialRows.length !== ids.length)
        return { error: PAYOUT_ERROR.INVALID };

      const first = initialRows[0];
      if (!first.programId || !first.merchantId)
        return { error: PAYOUT_ERROR.INVALID };
      const group: PayoutEligibilityGroup = {
        merchantId: first.merchantId,
        affiliateId: first.affiliateId,
        programId: first.programId,
        currency: first.currency,
      };
      if (
        initialRows.some(
          (row) =>
            row.affiliateId !== group.affiliateId ||
            row.programId !== group.programId ||
            row.currency !== group.currency,
        )
      ) {
        return {
          error: PAYOUT_ERROR.MIXED_GROUP,
        };
      }

      if (
        !(await lockPayoutEligibilityProgram(tx, merchantId, group.programId))
      ) {
        return { error: PAYOUT_ERROR.INVALID };
      }
      await lockPayoutEligibilityGroup(tx, group);
      await tx.$queryRaw(Prisma.sql`
        SELECT ${SqlSchema.tables.Commission.id}
        FROM ${SqlSchema.tables.Commission.name}
        WHERE ${SqlSchema.tables.Commission.id} IN (${Prisma.join(ids)})
          AND ${SqlSchema.tables.Commission.merchantId} = ${merchantId}
        ORDER BY ${SqlSchema.tables.Commission.id}
        FOR UPDATE
      `);

      const rows = await tx.commission.findMany({
        where: { id: { in: ids }, merchantId, affiliateId: group.affiliateId },
        select: {
          id: true,
          programId: true,
          currency: true,
          status: true,
          amount: true,
          payableAt: true,
          adjustsCommissionId: true,
          payoutId: true,
          flagReason: true,
          disputeOpenedAt: true,
          checkoutConflictHeldAt: true,
        },
      });
      if (rows.length !== ids.length) return { error: PAYOUT_ERROR.INVALID };

      const selectedTotal = rows.reduce(
        (sum, row) => sum.add(row.amount),
        new Prisma.Decimal(0),
      );
      const eligibility = await getPayoutEligibility(tx, group, now);
      if (!eligibility) return { error: PAYOUT_ERROR.INVALID };

      const payoutStatus =
        closeoutReason === null
          ? COMMISSION_STATUS.PAYABLE
          : COMMISSION_STATUS.PENDING;
      const expectedRows = await listPayoutSnapshotCommissions(
        tx,
        group,
        payoutStatus,
        MAX_SHOWN,
        now,
      );
      const snapshotAmounts = new Map(
        expectedRows.map((row) => [row.id, row.amount]),
      );
      if (
        rows.some((row) => {
          const snapshotAmount = snapshotAmounts.get(row.id);
          const shownAmount = amounts.get(row.id);
          return (
            snapshotAmount === undefined ||
            shownAmount === undefined ||
            !snapshotAmount.eq(shownAmount)
          );
        })
      ) {
        return { error: PAYOUT_ERROR.INELIGIBLE };
      }

      for (const row of rows) {
        const expectedAmount = amounts.get(row.id);
        if (
          row.programId !== group.programId ||
          row.currency !== group.currency ||
          expectedAmount === undefined ||
          !row.amount.eq(expectedAmount) ||
          row.amount.lte(0) ||
          row.adjustsCommissionId !== null ||
          row.payoutId !== null ||
          row.flagReason !== null ||
          row.disputeOpenedAt !== null ||
          row.checkoutConflictHeldAt !== null ||
          row.payableAt.getTime() > now.getTime()
        ) {
          return { error: PAYOUT_ERROR.INELIGIBLE };
        }
        if (
          closeoutReason === null &&
          row.status !== COMMISSION_STATUS.PAYABLE
        ) {
          return { error: PAYOUT_ERROR.INELIGIBLE };
        }
        if (
          closeoutReason !== null &&
          row.status !== COMMISSION_STATUS.PENDING
        ) {
          return { error: PAYOUT_ERROR.CLOSEOUT };
        }
      }

      if (closeoutReason === null) {
        if (!eligibility.payable || selectedTotal.lt(eligibility.minimum)) {
          return {
            error: PAYOUT_ERROR.BELOW_MINIMUM,
          };
        }
      } else if (
        eligibility.payable ||
        eligibility.eligibleBalance.gte(eligibility.minimum)
      ) {
        return { error: PAYOUT_ERROR.CLOSEOUT };
      }

      const paidAt = new Date();
      const payout = await tx.payout.create({
        data: {
          merchantId,
          affiliateId: group.affiliateId,
          programId: group.programId,
          currency: group.currency,
          total: selectedTotal,
          paidAt,
          note: payoutNote,
          isException: closeoutReason !== null,
          exceptionReason: closeoutReason,
        },
        select: { id: true },
      });
      const updated = await tx.commission.updateMany({
        where: {
          id: { in: ids },
          merchantId,
          affiliateId: group.affiliateId,
          programId: group.programId,
          currency: group.currency,
          status:
            closeoutReason === null
              ? COMMISSION_STATUS.PAYABLE
              : COMMISSION_STATUS.PENDING,
          payoutId: null,
          adjustsCommissionId: null,
          flagReason: null,
          disputeOpenedAt: null,
          checkoutConflictHeldAt: null,
          payableAt: { lte: now },
        },
        data: {
          status: COMMISSION_STATUS.PAID,
          paidAt,
          paidNote: payoutNote,
          payoutId: payout.id,
        },
      });
      if (updated.count !== rows.length) {
        throw new PayoutWriteConflict(
          "Commission changed during payout recording",
        );
      }

      await recalculatePayoutEligibility(tx, group, paidAt);
      return { count: rows.length, payoutId: payout.id };
    });
  } catch (error) {
    if (error instanceof PayoutWriteConflict) {
      return { error: PAYOUT_ERROR.INELIGIBLE };
    }
    throw error;
  }
}
/**
 * Confirm that a referral was the affiliate referring themselves, from any of
 * its commissions.
 *
 * Any status is accepted, because a self referral the checks missed is often
 * spotted after its row was voided by hand, refunded, or paid. The row pressed
 * on is only the way in: the decision is about its click. Every unpaid
 * commission on the click is voided, paid ones stay paid because a paid
 * commission is final, and the click is marked so nothing it brings later
 * earns.
 *
 * Pressing it again, or on another row of a referral already confirmed, does
 * nothing new and does not throw: the first confirmation's date is kept.
 *
 * An adjustment row is refused. It records a refund on a sale, not a referral
 * the Owner is judging.
 */
export async function confirmCommissionFraud(
  ownerId: string,
  merchantId: string,
  commissionId: string,
): Promise<void> {
  await assertMerchantOwnership(ownerId, merchantId);

  const existing = await db.commission.findFirst({
    where: {
      id: commissionId,
      adjustsCommissionId: null,
      affiliate: { merchantId },
    },
    select: { clickId: true },
  });
  if (!existing) {
    throw new Error("Commission not found, or a refund adjustment");
  }

  const now = new Date();
  const confirmed = {
    status: COMMISSION_STATUS.VOIDED,
    voidedAt: now,
    voidReason: "confirmed self-referral",
  };
  await db.$transaction(async (tx) => {
    // The click first. The worker holds it for share while it checks it and
    // writes a commission, so either that row is committed before the void
    // below reads the click's rows, or the worker waits and then finds the
    // click confirmed. Without it a renewal written in between earned.
    await tx.$queryRaw(Prisma.sql`
      SELECT ${SqlSchema.tables.Click.id}
      FROM ${SqlSchema.tables.Click.name}
      WHERE ${SqlSchema.tables.Click.id} = ${existing.clickId}
      FOR UPDATE
    `);

    const impactedGroups = await tx.commission.findMany({
      where: {
        clickId: existing.clickId,
        adjustsCommissionId: null,
        status: { in: [...UNPAID_COMMISSION_STATUSES] },
        merchantId,
        programId: { not: null },
      },
      distinct: ["affiliateId", "programId", "currency"],
      select: {
        merchantId: true,
        affiliateId: true,
        programId: true,
        currency: true,
      },
    });
    const groups = impactedGroups
      .filter((group) => group.merchantId && group.programId)
      .map((group) => ({
        merchantId: group.merchantId!,
        affiliateId: group.affiliateId,
        programId: group.programId!,
        currency: group.currency,
      }))
      .sort((a, b) =>
        `${a.merchantId}:${a.programId}:${a.affiliateId}:${a.currency}`.localeCompare(
          `${b.merchantId}:${b.programId}:${b.affiliateId}:${b.currency}`,
        ),
      );
    for (const group of groups) {
      if (
        !(await lockPayoutEligibilityProgram(
          tx,
          group.merchantId,
          group.programId,
        ))
      ) {
        continue;
      }
      await lockPayoutEligibilityGroup(tx, group);
    }

    // Bucket locks come before commission row locks, matching Mark paid.
    // Within the click, rows use id order so simultaneous referrals remain
    // deterministic as well.
    await tx.$queryRaw(Prisma.sql`
      SELECT ${SqlSchema.tables.Commission.id}
      FROM ${SqlSchema.tables.Commission.name}
      WHERE ${SqlSchema.tables.Commission.clickId} = ${existing.clickId}
        AND ${SqlSchema.tables.Commission.adjustsCommissionId} IS NULL
        AND ${SqlSchema.tables.Commission.status} IN (
          ${COMMISSION_STATUS.PENDING}::${SqlSchema.types.CommissionStatus},
          ${COMMISSION_STATUS.PAYABLE}::${SqlSchema.types.CommissionStatus},
          ${COMMISSION_STATUS.FLAGGED}::${SqlSchema.types.CommissionStatus}
        )
      ORDER BY ${SqlSchema.tables.Commission.id}
      FOR UPDATE
    `);

    // The referral was the self referral, not only this one payment, so
    // nothing it earned that has not been paid out yet stands. Only unpaid
    // statuses are written, so a row a refund or the Owner already voided
    // keeps its own reason, and paid commissions stay paid. Adjustment rows
    // are left out, they are not commissions this referral earned.
    await tx.commission.updateMany({
      where: {
        clickId: existing.clickId,
        adjustsCommissionId: null,
        status: { in: [...UNPAID_COMMISSION_STATUSES] },
      },
      data: confirmed,
    });

    for (const group of groups) {
      await recalculatePayoutEligibility(tx, group, now);
    }

    // Voiding rows alone left the referral earning: the next renewal created
    // a fresh commission. Marking the click stops every later payment it
    // brings. The first confirmation's date is kept.
    await tx.click.updateMany({
      where: { id: existing.clickId, fraudConfirmedAt: null },
      data: { fraudConfirmedAt: now },
    });
  });
}

// The reasons the worker and `confirmCommissionFraud` write verbatim, never
// typed by an Owner. Compared case-insensitively: an Owner typing the same
// words is still the Owner's own decision, not the automatic void those
// literals otherwise mean to payout history and `voidReasonText`.
const SYSTEM_VOID_REASONS: readonly string[] = [
  "refund",
  "chargeback",
  "partial refund",
  "confirmed self-referral",
  "refund after payout",
];

/**
 * Cancel a commission the Owner has decided not to pay, with a reason.
 *
 * PAID is terminal: a paid commission is final, whether the Owner or a later
 * refund would change it. Voiding twice is refused for the same reason it is
 * refused elsewhere, so a double submit cannot overwrite the reason the first
 * one recorded.
 *
 * An adjustment row is refused outright. None are written any more, and the
 * few an older version left unpaid are voided by a migration.
 *
 * A typed reason that happens to match one of the worker's own words is
 * suffixed before it is stored. Without that, the payout ledger could read an Owner's
 * void of "refund" as the refund void a stale Mark paid is allowed to record
 * over, which would silently overturn the Owner's decision.
 */
export async function voidCommission(
  ownerId: string,
  merchantId: string,
  commissionId: string,
  reason: string,
): Promise<void> {
  await assertMerchantOwnership(ownerId, merchantId);

  const existing = await db.commission.findFirst({
    where: {
      id: commissionId,
      status: { in: [...UNPAID_COMMISSION_STATUSES] },
      adjustsCommissionId: null,
      affiliate: { merchantId },
    },
    select: { id: true },
  });
  if (!existing) {
    throw new Error(
      "Commission not found, or already paid, voided, or a refund adjustment",
    );
  }

  const stored = SYSTEM_VOID_REASONS.includes(reason.trim().toLowerCase())
    ? `${reason} (by owner)`
    : reason;

  // Conditional on the same statuses as the read, so a commission paid out
  // in the moment between the two is refused rather than voided after the
  // money left.
  const { count } = await db.$transaction(async (tx) => {
    const group = await lockCommissionPayoutEligibilityGroup(
      tx,
      commissionId,
      merchantId,
    );
    if (!group) return { count: 0 };
    const result = await tx.commission.updateMany({
      where: {
        id: commissionId,
        merchantId,
        status: { in: [...UNPAID_COMMISSION_STATUSES] },
      },
      data: {
        status: COMMISSION_STATUS.VOIDED,
        voidedAt: new Date(),
        voidReason: stored,
      },
    });
    if (result.count > 0) await recalculatePayoutEligibility(tx, group);
    return result;
  });
  if (count === 0) {
    throw new Error(
      "Commission not found, or already paid, voided, or a refund adjustment",
    );
  }
}

export async function dismissCommissionFlag(
  ownerId: string,
  merchantId: string,
  commissionId: string,
): Promise<void> {
  await assertMerchantOwnership(ownerId, merchantId);

  const existing = await db.commission.findFirst({
    where: {
      id: commissionId,
      status: COMMISSION_STATUS.FLAGGED,
      affiliate: { merchantId },
    },
    select: { id: true },
  });
  if (!existing) {
    throw new Error("Flagged commission not found");
  }

  // Straight to PAYABLE only when the Holding Period is over and no dispute
  // holds the commission. Both conditions sit in the write rather than in a
  // read before it, so a dispute that opens in between leaves the row PENDING.
  // Still FLAGGED at write time in both writes, so a commission a refund voided
  // in between is not brought back to life.
  const { count } = await db.$transaction(async (tx) => {
    const group = await lockCommissionPayoutEligibilityGroup(
      tx,
      commissionId,
      merchantId,
    );
    if (!group) return { count: 0 };
    const result = await tx.commission.updateMany({
      where: {
        id: commissionId,
        merchantId,
        status: COMMISSION_STATUS.FLAGGED,
      },
      data: { status: COMMISSION_STATUS.PENDING, flagReason: null },
    });
    if (result.count > 0) await recalculatePayoutEligibility(tx, group);
    return result;
  });
  if (count === 0) {
    throw new Error("Flagged commission not found");
  }
}
