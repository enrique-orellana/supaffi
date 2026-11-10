import { Prisma } from "@prisma/client";
import type { Affiliate, Click, Program } from "@prisma/client";

export type CommissionTermProgram = Pick<
  Program,
  | "id"
  | "defaultCommissionRate"
  | "commissionDurationType"
  | "commissionDurationMonths"
  | "attributionWindowDays"
  | "holdingPeriodDays"
  | "minimumPayoutAmount"
>;

export type CommissionTermAffiliate = Pick<Affiliate, "programId"> &
  Partial<
    Pick<
      Affiliate,
      | "customCommissionRate"
      | "commissionDurationTypeOverride"
      | "commissionDurationMonthsOverride"
      | "attributionWindowDaysOverride"
      | "holdingPeriodDaysOverride"
      | "minimumPayoutAmountOverride"
    >
  >;

export type ClickCommissionTermSnapshot = Pick<
  Click,
  | "commissionRateSnapshot"
  | "commissionDurationTypeSnapshot"
  | "commissionDurationMonthsSnapshot"
  | "holdingPeriodDaysSnapshot"
>;

export type CommissionDurationTerms = Pick<
  Program,
  "commissionDurationType" | "commissionDurationMonths"
>;

export type CurrentCommissionTerms = {
  commissionRate: Prisma.Decimal;
  commissionRateSource: "program" | "affiliate";
  commissionDuration: CommissionDurationTerms;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  minimumPayoutAmount: Prisma.Decimal;
};

export type ClickCommissionTerms = Pick<
  CurrentCommissionTerms,
  "commissionRate" | "commissionDuration" | "holdingPeriodDays"
>;

function affiliateTermsForProgram<T extends { programId: string }>(
  programId: string,
  affiliate: T | null | undefined,
): T | null {
  return affiliate?.programId === programId ? affiliate : null;
}

/** Resolve Program defaults and any overrides for the Affiliate assigned to it. */
export function resolveCurrentCommissionTerms(
  program: CommissionTermProgram,
  affiliate?: CommissionTermAffiliate | null,
): CurrentCommissionTerms {
  const assignedAffiliate = affiliateTermsForProgram(program.id, affiliate);
  const durationType =
    assignedAffiliate?.commissionDurationTypeOverride ??
    program.commissionDurationType;
  const durationMonths =
    durationType === "FIXED_MONTHS"
      ? (assignedAffiliate?.commissionDurationMonthsOverride ??
        program.commissionDurationMonths)
      : null;
  const affiliateRate = assignedAffiliate?.customCommissionRate;

  return {
    commissionRate: affiliateRate ?? program.defaultCommissionRate,
    commissionRateSource:
      affiliateRate === null || affiliateRate === undefined
        ? "program"
        : "affiliate",
    commissionDuration: {
      commissionDurationType: durationType,
      commissionDurationMonths: durationMonths,
    },
    attributionWindowDays:
      assignedAffiliate?.attributionWindowDaysOverride ??
      program.attributionWindowDays,
    holdingPeriodDays:
      assignedAffiliate?.holdingPeriodDaysOverride ?? program.holdingPeriodDays,
    minimumPayoutAmount: resolveMinimumPayoutAmount(program, assignedAffiliate),
  };
}

/** Persist the resolved commission terms so later Program edits cannot rewrite a referral. */
export function clickCommissionTermSnapshot(
  terms: CurrentCommissionTerms,
): ClickCommissionTermSnapshot {
  return {
    commissionRateSnapshot: terms.commissionRate,
    commissionDurationTypeSnapshot:
      terms.commissionDuration.commissionDurationType,
    commissionDurationMonthsSnapshot:
      terms.commissionDuration.commissionDurationMonths,
    holdingPeriodDaysSnapshot: terms.holdingPeriodDays,
  };
}

/** Capture the attribution window as an absolute expiry when the Click is created. */
export function attributionExpiry(createdAt: Date, windowDays: number): Date {
  return new Date(createdAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

/** A click freezes commission terms; legacy clicks inherit current terms. */
export function resolveClickCommissionTerms(
  program: CommissionTermProgram,
  affiliate: CommissionTermAffiliate | null | undefined,
  click: ClickCommissionTermSnapshot | null | undefined,
): ClickCommissionTerms {
  const current = resolveCurrentCommissionTerms(program, affiliate);
  const capturedDurationType = click?.commissionDurationTypeSnapshot;

  return {
    commissionRate: click?.commissionRateSnapshot ?? current.commissionRate,
    commissionDuration:
      capturedDurationType === null || capturedDurationType === undefined
        ? current.commissionDuration
        : {
            commissionDurationType: capturedDurationType,
            commissionDurationMonths:
              capturedDurationType === "FIXED_MONTHS"
                ? (click?.commissionDurationMonthsSnapshot ?? null)
                : null,
          },
    holdingPeriodDays:
      click?.holdingPeriodDaysSnapshot ?? current.holdingPeriodDays,
  };
}

/** Resolve the assigned Affiliate's payout minimum, falling back to its Program. */
export function resolveMinimumPayoutAmount(
  program: Pick<Program, "id" | "minimumPayoutAmount">,
  affiliate?:
    | (Pick<Affiliate, "programId"> &
        Partial<Pick<Affiliate, "minimumPayoutAmountOverride">>)
    | null,
): Prisma.Decimal {
  const override =
    affiliate?.programId === program.id
      ? affiliate.minimumPayoutAmountOverride
      : null;
  if (override !== null && override !== undefined) return override;
  return program.minimumPayoutAmount;
}
