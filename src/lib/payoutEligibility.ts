import { CommissionStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { resolveMinimumPayoutAmount } from "@/lib/commissionTerms";
import type { ProgramMinimumImpactSummary } from "@/lib/programValidation";

export type PayoutEligibilityGroup = {
  merchantId: string;
  affiliateId: string;
  programId: string;
  currency: string;
};

type EligibilityClient = typeof db | Prisma.TransactionClient;

const REEVALUATABLE_STATUSES: CommissionStatus[] = [
  COMMISSION_STATUS.PENDING,
  COMMISSION_STATUS.PAYABLE,
];

function eligibleCommissionWhere(group: PayoutEligibilityGroup, now: Date) {
  return {
    merchantId: group.merchantId,
    affiliateId: group.affiliateId,
    programId: group.programId,
    currency: group.currency,
    status: { in: REEVALUATABLE_STATUSES },
    adjustsCommissionId: null,
    payoutId: null,
    amount: { gt: new Prisma.Decimal(0) },
    payableAt: { lte: now },
    flagReason: null,
    disputeOpenedAt: null,
    checkoutConflictHeldAt: null,
  };
}

/** The deterministic, capped commission snapshot a payout screen displays. */
export async function listPayoutSnapshotCommissions(
  client: EligibilityClient,
  group: PayoutEligibilityGroup,
  status: typeof COMMISSION_STATUS.PENDING | typeof COMMISSION_STATUS.PAYABLE,
  limit: number,
  now: Date = new Date(),
) {
  return client.commission.findMany({
    where: { ...eligibleCommissionWhere(group, now), status },
    select: { id: true, amount: true },
    orderBy: [{ payableAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

/** Serialize all balance-changing work for one Affiliate/Program/currency. */
export async function lockPayoutEligibilityGroup(
  tx: Prisma.TransactionClient,
  group: PayoutEligibilityGroup,
): Promise<void> {
  const key = [
    group.merchantId,
    group.affiliateId,
    group.programId,
    group.currency,
  ].join("\u001f");
  await tx.$queryRaw<{ locked: number }[]>(
    Prisma.sql`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `,
  );
}

/** Lock the Program and balance bucket before changing a Commission's eligibility. */
export async function lockCommissionPayoutEligibilityGroup(
  tx: Prisma.TransactionClient,
  commissionId: string,
  merchantId?: string,
): Promise<PayoutEligibilityGroup | null> {
  const commission = await tx.commission.findFirst({
    where: {
      id: commissionId,
      ...(merchantId ? { merchantId } : {}),
    },
    select: {
      merchantId: true,
      affiliateId: true,
      programId: true,
      currency: true,
    },
  });
  if (!commission?.merchantId || !commission.programId) return null;

  const group: PayoutEligibilityGroup = {
    merchantId: commission.merchantId,
    affiliateId: commission.affiliateId,
    programId: commission.programId,
    currency: commission.currency,
  };
  if (
    !(await lockPayoutEligibilityProgram(tx, group.merchantId, group.programId))
  ) {
    return null;
  }
  await lockPayoutEligibilityGroup(tx, group);
  return group;
}

export async function lockPayoutEligibilityProgram(
  tx: Prisma.TransactionClient,
  merchantId: string,
  programId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "Program"
    WHERE "id" = ${programId} AND "merchantId" = ${merchantId}
    FOR SHARE
  `);
  return rows.length > 0;
}

export async function getPayoutEligibility(
  client: EligibilityClient,
  group: PayoutEligibilityGroup,
  now: Date = new Date(),
): Promise<{
  minimum: Prisma.Decimal;
  eligibleBalance: Prisma.Decimal;
  payable: boolean;
} | null> {
  const [program, affiliate, aggregate] = await Promise.all([
    client.program.findFirst({
      where: { id: group.programId, merchantId: group.merchantId },
      select: { id: true, minimumPayoutAmount: true },
    }),
    client.affiliate.findFirst({
      where: { id: group.affiliateId, merchantId: group.merchantId },
      select: {
        id: true,
        programId: true,
        minimumPayoutAmountOverride: true,
      },
    }),
    client.commission.aggregate({
      where: eligibleCommissionWhere(group, now),
      _sum: { amount: true },
    }),
  ]);
  if (!program || !affiliate) return null;
  const minimum = resolveMinimumPayoutAmount(program, affiliate);
  const eligibleBalance = aggregate._sum.amount ?? new Prisma.Decimal(0);
  return {
    minimum,
    eligibleBalance,
    payable: eligibleBalance.gte(minimum),
  };
}

/** Recompute statuses from the one shared definition of an eligible balance. */
export async function recalculatePayoutEligibility(
  tx: Prisma.TransactionClient,
  group: PayoutEligibilityGroup,
  now: Date = new Date(),
): Promise<{ changed: number; eligibleBalance: Prisma.Decimal }> {
  if (
    !(await lockPayoutEligibilityProgram(tx, group.merchantId, group.programId))
  ) {
    return { changed: 0, eligibleBalance: new Prisma.Decimal(0) };
  }
  await lockPayoutEligibilityGroup(tx, group);
  const eligibility = await getPayoutEligibility(tx, group, now);
  if (!eligibility)
    return { changed: 0, eligibleBalance: new Prisma.Decimal(0) };

  const updated = await tx.commission.updateMany({
    where: {
      ...eligibleCommissionWhere(group, now),
      status: eligibility.payable
        ? COMMISSION_STATUS.PENDING
        : COMMISSION_STATUS.PAYABLE,
    },
    data: {
      status: eligibility.payable
        ? COMMISSION_STATUS.PAYABLE
        : COMMISSION_STATUS.PENDING,
    },
  });
  return {
    changed: updated.count,
    eligibleBalance: eligibility.eligibleBalance,
  };
}

/** Recalculate every unpaid group after a Program minimum changes. */
export async function recalculateProgramPayoutEligibility(
  tx: Prisma.TransactionClient,
  merchantId: string,
  programId: string,
  now: Date = new Date(),
): Promise<void> {
  const groups = await tx.commission.findMany({
    where: {
      merchantId,
      programId,
      status: { in: REEVALUATABLE_STATUSES },
      adjustsCommissionId: null,
      amount: { gt: new Prisma.Decimal(0) },
    },
    distinct: ["affiliateId", "currency"],
    select: { affiliateId: true, currency: true },
    orderBy: [{ affiliateId: "asc" }, { currency: "asc" }],
  });
  for (const group of groups) {
    await recalculatePayoutEligibility(
      tx,
      {
        merchantId,
        programId,
        affiliateId: group.affiliateId,
        currency: group.currency,
      },
      now,
    );
  }
}

/** Recompute the Affiliate's existing Program/currency groups after settings change. */
export async function recalculateAffiliatePayoutEligibility(
  tx: Prisma.TransactionClient,
  merchantId: string,
  affiliateId: string,
  now: Date = new Date(),
): Promise<void> {
  const groups = await tx.commission.findMany({
    where: {
      merchantId,
      affiliateId,
      programId: { not: null },
      status: { in: REEVALUATABLE_STATUSES },
      adjustsCommissionId: null,
      payoutId: null,
      amount: { gt: new Prisma.Decimal(0) },
    },
    distinct: ["programId", "currency"],
    select: { programId: true, currency: true },
    orderBy: [{ programId: "asc" }, { currency: "asc" }],
  });

  for (const group of groups) {
    if (!group.programId) continue;
    await recalculatePayoutEligibility(
      tx,
      {
        merchantId,
        affiliateId,
        programId: group.programId,
        currency: group.currency,
      },
      now,
    );
  }
}

export type ProgramMinimumImpact = {
  affiliateId: string;
  affiliateName: string | null;
  currency: string;
  eligibleBalance: string;
  currentlyPayable: string;
};

export function summarizeProgramMinimumImpact(
  impact: ProgramMinimumImpact[],
): ProgramMinimumImpactSummary {
  const totals = new Map<string, Prisma.Decimal>();
  for (const group of impact) {
    totals.set(
      group.currency,
      (totals.get(group.currency) ?? new Prisma.Decimal(0)).add(
        group.currentlyPayable,
      ),
    );
  }
  return {
    fingerprint: impact
      .map(
        (group) =>
          `${group.affiliateId}:${group.currency}:${group.eligibleBalance}:${group.currentlyPayable}`,
      )
      .join("|"),
    groupCount: impact.length,
    examples: impact.slice(0, 5),
    currentlyPayableByCurrency: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, total]) => ({ currency, total: total.toFixed(2) })),
  };
}

/** Payable groups that a proposed new minimum would move below threshold. */
export async function getProgramMinimumImpact(
  merchantId: string,
  programId: string,
  newMinimum: string,
  now: Date = new Date(),
  client: EligibilityClient = db,
): Promise<ProgramMinimumImpact[]> {
  const proposedMinimum = new Prisma.Decimal(newMinimum);
  const grouped = await client.commission.groupBy({
    by: ["affiliateId", "currency", "status"],
    where: {
      merchantId,
      programId,
      status: { in: REEVALUATABLE_STATUSES },
      adjustsCommissionId: null,
      payoutId: null,
      amount: { gt: new Prisma.Decimal(0) },
      payableAt: { lte: now },
      flagReason: null,
      disputeOpenedAt: null,
      checkoutConflictHeldAt: null,
      affiliate: {
        is: {
          merchantId,
        },
      },
    },
    _sum: { amount: true },
  });

  const byGroup = new Map<
    string,
    {
      affiliateId: string;
      currency: string;
      eligibleBalance: Prisma.Decimal;
      currentlyPayable: Prisma.Decimal;
    }
  >();
  for (const row of grouped) {
    const key = `${row.affiliateId}\u001f${row.currency}`;
    const group = byGroup.get(key) ?? {
      affiliateId: row.affiliateId,
      currency: row.currency,
      eligibleBalance: new Prisma.Decimal(0),
      currentlyPayable: new Prisma.Decimal(0),
    };
    const amount = row._sum.amount ?? new Prisma.Decimal(0);
    group.eligibleBalance = group.eligibleBalance.add(amount);
    if (row.status === COMMISSION_STATUS.PAYABLE) {
      group.currentlyPayable = group.currentlyPayable.add(amount);
    }
    byGroup.set(key, group);
  }

  const candidates = [...byGroup.values()].filter((group) =>
    group.currentlyPayable.gt(0),
  );
  if (candidates.length === 0) return [];

  const affiliates = await client.affiliate.findMany({
    where: {
      id: { in: [...new Set(candidates.map((group) => group.affiliateId))] },
      merchantId,
    },
    select: {
      id: true,
      name: true,
      programId: true,
      minimumPayoutAmountOverride: true,
    },
  });
  const affiliatesById = new Map(
    affiliates.map((affiliate) => [affiliate.id, affiliate]),
  );
  const proposedProgram = {
    id: programId,
    minimumPayoutAmount: proposedMinimum,
  };
  const impacted = candidates.filter((group) =>
    group.eligibleBalance.lt(
      resolveMinimumPayoutAmount(
        proposedProgram,
        affiliatesById.get(group.affiliateId),
      ),
    ),
  );
  return impacted
    .map((group) => ({
      affiliateId: group.affiliateId,
      affiliateName: affiliatesById.get(group.affiliateId)?.name ?? null,
      currency: group.currency,
      eligibleBalance: group.eligibleBalance.toFixed(2),
      currentlyPayable: group.currentlyPayable.toFixed(2),
    }))
    .sort((a, b) =>
      `${a.affiliateName ?? a.affiliateId}:${a.currency}`.localeCompare(
        `${b.affiliateName ?? b.affiliateId}:${b.currency}`,
      ),
    );
}
