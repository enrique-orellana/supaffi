export const CommissionDuration = {
  ONE_TIME: "ONE_TIME",
  FIXED_MONTHS: "FIXED_MONTHS",
  FOREVER: "FOREVER",
} as const;

export type CommissionDurationValue = (typeof CommissionDuration)[keyof typeof CommissionDuration];

export const COMMISSION_DURATION_OPTIONS: readonly { value: CommissionDurationValue; label: string }[] = [
  { value: CommissionDuration.FOREVER, label: "of every payment, forever" },
  { value: CommissionDuration.FIXED_MONTHS, label: "of every payment, for some months" },
  { value: CommissionDuration.ONE_TIME, label: "of the first payment only" },
];

export function isCommissionDuration(value: unknown): value is CommissionDurationValue {
  return Object.values(CommissionDuration).some((duration) => duration === value);
}

export function commissionDurationLabel(
  type: CommissionDurationValue,
  months: number | null
): string {
  if (type === CommissionDuration.FIXED_MONTHS) {
    if (months === null) return "of every payment, for a fixed term";
    return `of every payment, for ${months} month${months === 1 ? "" : "s"}`;
  }
  return COMMISSION_DURATION_OPTIONS.find((option) => option.value === type)!.label;
}

/** Parse an Owner's per-code override; null means the form value is invalid. */
export function parseCommissionDurationOverride(
  type: unknown,
  rawMonths: unknown
): { type: CommissionDurationValue; months: number | null } | null {
  if (!isCommissionDuration(type)) return null;
  if (type !== CommissionDuration.FIXED_MONTHS) return { type, months: null };

  const months = Number(rawMonths);
  if (!Number.isFinite(months) || months <= 0 || !Number.isInteger(months)) return null;
  return { type, months };
}
