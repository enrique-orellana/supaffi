import type { ProgramInput } from "@/lib/program";
import { isCommissionDuration } from "@/lib/commissionDuration";
import {
  MAX_COMMISSION_DURATION_MONTHS,
  MAX_COMMISSION_TERM_DAYS,
} from "@/lib/commissionTermLimits";
import {
  DEFAULT_DISPLAY_CURRENCY,
  normalizeDisplayCurrency,
} from "@/lib/displayCurrencyOptions";

export type ProgramFormValues = {
  name: string;
  defaultCommissionRate: string;
  commissionDurationType: string;
  commissionDurationMonths: string;
  attributionWindowDays: string;
  holdingPeriodDays: string;
  currency?: string;
  minimumPayoutAmount?: string;
};

export type ProgramMinimumImpactSummary = {
  fingerprint: string;
  groupCount: number;
  examples: {
    affiliateId: string;
    affiliateName: string | null;
    currency: string;
    eligibleBalance: string;
    currentlyPayable: string;
  }[];
  currentlyPayableByCurrency: { currency: string; total: string }[];
};

export type ProgramFormSnapshot = ProgramFormValues & {
  signupOpen?: boolean;
};

export type ProgramActionState = {
  error: string;
  values?: ProgramFormSnapshot;
  editConfirmation?: boolean;
  minimumConfirmation?: ProgramMinimumImpactSummary;
};

export function validateProgramInput(
  input: ProgramFormValues,
):
  | { error: string; parsed?: undefined }
  | { error: null; parsed: ProgramInput } {
  if (!input.name.trim()) return { error: "Name is required" };

  const submittedCurrency = input.currency?.trim();
  const currency = submittedCurrency
    ? normalizeDisplayCurrency(submittedCurrency)
    : DEFAULT_DISPLAY_CURRENCY;
  if (!currency) {
    return { error: "Choose a supported affiliate display currency" };
  }

  const minimumPayoutAmount = input.minimumPayoutAmount?.trim() || "0";
  if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(minimumPayoutAmount)) {
    return {
      error:
        "Minimum balance must be zero or more with up to two decimal places",
    };
  }
  const [minimumWhole, minimumFraction = ""] = minimumPayoutAmount.split(".");
  const normalizedMinimumPayoutAmount = `${minimumWhole}.${minimumFraction.padEnd(2, "0")}`;

  const rate = Number(input.defaultCommissionRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return {
      error: "Commission rate must be greater than 0 and no more than 100",
    };
  }

  const durationType = input.commissionDurationType;
  if (!isCommissionDuration(durationType)) {
    return { error: "Invalid commission duration type" };
  }

  let commissionDurationMonths: number | null = null;
  if (durationType === "FIXED_MONTHS") {
    const months = Number(input.commissionDurationMonths);
    if (!Number.isFinite(months) || months <= 0 || !Number.isInteger(months)) {
      return { error: "Enter how many months the commission is paid for" };
    }
    if (months > MAX_COMMISSION_DURATION_MONTHS) {
      return {
        error: `Commission duration cannot exceed ${MAX_COMMISSION_DURATION_MONTHS.toLocaleString()} months`,
      };
    }
    commissionDurationMonths = months;
  }

  const attributionWindowDays = Number(input.attributionWindowDays);
  if (
    !Number.isFinite(attributionWindowDays) ||
    attributionWindowDays <= 0 ||
    !Number.isInteger(attributionWindowDays)
  ) {
    return { error: "Time to buy must be a whole number of days, at least 1" };
  }
  if (attributionWindowDays > MAX_COMMISSION_TERM_DAYS) {
    return {
      error: `Time to buy cannot exceed ${MAX_COMMISSION_TERM_DAYS.toLocaleString()} days`,
    };
  }

  const holdingPeriodDays = Number(input.holdingPeriodDays);
  if (
    !Number.isFinite(holdingPeriodDays) ||
    holdingPeriodDays <= 0 ||
    !Number.isInteger(holdingPeriodDays)
  ) {
    return {
      error: "Hold before paying must be a whole number of days, at least 1",
    };
  }
  if (holdingPeriodDays > MAX_COMMISSION_TERM_DAYS) {
    return {
      error: `Hold before paying cannot exceed ${MAX_COMMISSION_TERM_DAYS.toLocaleString()} days`,
    };
  }

  return {
    error: null,
    parsed: {
      name: input.name.trim(),
      defaultCommissionRate: rate,
      commissionDurationType: durationType,
      commissionDurationMonths,
      attributionWindowDays,
      holdingPeriodDays,
      currency,
      minimumPayoutAmount: normalizedMinimumPayoutAmount,
    },
  };
}
