import { db } from "@/lib/db";
import type { CommissionDurationType } from "@prisma/client";
import { uniqueSlug } from "@/lib/slug";
import { SUPPORTED_DISPLAY_CURRENCY_CODES } from "@/lib/displayCurrencyOptions";
import { Prisma } from "@prisma/client";
import {
  getProgramMinimumImpact,
  recalculateProgramPayoutEligibility,
  summarizeProgramMinimumImpact,
  type ProgramMinimumImpact,
} from "@/lib/payoutEligibility";

export type DisplayCurrency = (typeof SUPPORTED_DISPLAY_CURRENCY_CODES)[number];

export type ProgramInput = {
  name: string;
  defaultCommissionRate: number;
  commissionDurationType: CommissionDurationType;
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  /** Omitted by legacy callers; the database default is EUR. */
  currency?: DisplayCurrency;
  /** Decimal string to preserve the entered two-place precision. */
  minimumPayoutAmount?: string;
  /** Left out by onboarding, which keeps the stored value (open by default). */
  signupOpen?: boolean;
};

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

export async function createProgram(
  ownerId: string,
  merchantId: string,
  input: ProgramInput,
): Promise<{ id: string; slug: string }> {
  await assertMerchantOwnership(ownerId, merchantId);

  const slug = await uniqueSlug(input.name, "program", async (candidate) =>
    Boolean(
      await db.program.findFirst({
        where: { merchantId, slug: candidate },
        select: { id: true },
      }),
    ),
  );

  return db.program.create({
    data: { merchantId, slug, ...input },
    select: { id: true, slug: true },
  });
}

export async function listProgramsForMerchant(
  ownerId: string,
  merchantId: string,
): Promise<
  {
    id: string;
    slug: string;
    name: string;
    defaultCommissionRate: unknown;
    commissionDurationType: CommissionDurationType;
    commissionDurationMonths: number | null;
    attributionWindowDays: number;
    holdingPeriodDays: number;
    currency: string;
    minimumPayoutAmount: string;
    signupOpen: boolean;
    affiliateCount: number;
  }[]
> {
  await assertMerchantOwnership(ownerId, merchantId);

  const programs = await db.program.findMany({
    where: { merchantId },
    select: {
      id: true,
      slug: true,
      name: true,
      defaultCommissionRate: true,
      commissionDurationType: true,
      commissionDurationMonths: true,
      attributionWindowDays: true,
      holdingPeriodDays: true,
      currency: true,
      minimumPayoutAmount: true,
      signupOpen: true,
      _count: { select: { affiliates: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // The product overview's Programs card reads this to say how many
  // affiliates each program has without a second round trip per row. The
  // Programs screen's cards read the duration/window/holding fields too, so
  // that grid doesn't need a second query per card either.
  return programs.map(({ _count, ...program }) => ({
    ...program,
    minimumPayoutAmount: program.minimumPayoutAmount.toFixed(2),
    affiliateCount: _count.affiliates,
  }));
}

export async function getProgramForMerchant(
  ownerId: string,
  merchantId: string,
  programSlug: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  defaultCommissionRate: unknown;
  commissionDurationType: CommissionDurationType;
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  currency: string;
  minimumPayoutAmount: string;
} | null> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { id: true },
  });
  if (!merchant) return null;

  const program = await db.program.findFirst({
    where: { slug: programSlug, merchantId },
    select: {
      id: true,
      slug: true,
      name: true,
      defaultCommissionRate: true,
      commissionDurationType: true,
      commissionDurationMonths: true,
      attributionWindowDays: true,
      holdingPeriodDays: true,
      currency: true,
      minimumPayoutAmount: true,
    },
  });
  return program
    ? {
        ...program,
        minimumPayoutAmount: program.minimumPayoutAmount.toFixed(2),
      }
    : null;
}

export async function updateProgram(
  ownerId: string,
  merchantId: string,
  programId: string,
  input: ProgramInput,
  confirmationFingerprint: string | null = null,
): Promise<ProgramMinimumImpact[] | null> {
  await assertMerchantOwnership(ownerId, merchantId);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM "Program"
      WHERE "id" = ${programId} AND "merchantId" = ${merchantId}
      FOR UPDATE
    `);
    if (rows.length === 0) throw new Error("Program not found");

    const existing = await tx.program.findUniqueOrThrow({
      where: { id: programId },
      select: {
        minimumPayoutAmount: true,
        commissionDurationType: true,
        commissionDurationMonths: true,
      },
    });
    const changedMinimum =
      input.minimumPayoutAmount !== undefined &&
      !existing.minimumPayoutAmount.eq(input.minimumPayoutAmount);
    const impact = changedMinimum
      ? await getProgramMinimumImpact(
          merchantId,
          programId,
          input.minimumPayoutAmount!,
          new Date(),
          tx,
        )
      : [];
    if (
      impact.length > 0 &&
      summarizeProgramMinimumImpact(impact).fingerprint !==
        confirmationFingerprint
    ) {
      return impact;
    }

    if (
      existing.commissionDurationType === "FIXED_MONTHS" &&
      input.commissionDurationType !== "FIXED_MONTHS" &&
      existing.commissionDurationMonths !== null
    ) {
      // Affiliate overrides that inherited the old fixed duration must keep
      // that duration when the Program no longer has a month count to inherit.
      await tx.affiliate.updateMany({
        where: {
          programId,
          commissionDurationTypeOverride: "FIXED_MONTHS",
          commissionDurationMonthsOverride: null,
        },
        data: {
          commissionDurationMonthsOverride:
            existing.commissionDurationMonths,
        },
      });
    }

    await tx.program.update({
      where: { id: programId },
      data: { ...input },
    });
    if (changedMinimum) {
      await recalculateProgramPayoutEligibility(tx, merchantId, programId);
    }
    return null;
  });
}

// Public — no Owner/session context. Scoped only by merchantId (resolved
// from the request's Host header by the caller), not by ownership, since
// this backs the public signup page.
//
// Looked up by slug: this is the one Program identifier that appears in a
// link sent to a stranger, and a cuid there reads like a tracking id.
export type ProgramForSignup = {
  id: string;
  name: string;
  /** Percentage, e.g. 20 for 20%. Decimal is not serialisable to a client component. */
  defaultCommissionRate: number;
  minimumPayoutAmount: string;
  commissionDurationType: CommissionDurationType;
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
};

export async function getProgramForSignup(
  merchantId: string,
  programSlug: string,
): Promise<ProgramForSignup | null> {
  const program = await db.program.findFirst({
    where: { slug: programSlug, merchantId, signupOpen: true },
    select: {
      id: true,
      name: true,
      defaultCommissionRate: true,
      minimumPayoutAmount: true,
      commissionDurationType: true,
      commissionDurationMonths: true,
      attributionWindowDays: true,
    },
  });
  if (!program) return null;
  return {
    ...program,
    defaultCommissionRate: Number(program.defaultCommissionRate),
    minimumPayoutAmount: program.minimumPayoutAmount.toFixed(2),
  };
}

/**
 * A program's name when it exists but has sign-ups closed, so its signup link
 * can say "invite only" rather than "not found". Null otherwise.
 */
export async function getClosedProgramName(
  merchantId: string,
  programSlug: string,
): Promise<string | null> {
  const program = await db.program.findFirst({
    where: { slug: programSlug, merchantId, signupOpen: false },
    select: { name: true },
  });
  return program?.name ?? null;
}

// Public, like getProgramForSignup: the program the bare affiliate address
// signs people up to, which is the oldest one still open.
export async function getDefaultProgramSlug(
  merchantId: string,
): Promise<string | null> {
  const program = await db.program.findFirst({
    where: { merchantId, signupOpen: true },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  return program?.slug ?? null;
}
