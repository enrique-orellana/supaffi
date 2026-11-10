"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CommissionDurationType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAffiliateResetLink } from "@/lib/affiliatePassword";
import { isCommissionDuration } from "@/lib/commissionDuration";
import {
  MAX_COMMISSION_DURATION_MONTHS,
  MAX_COMMISSION_TERM_DAYS,
} from "@/lib/commissionTermLimits";
import { recalculateAffiliatePayoutEligibility } from "@/lib/payoutEligibility";

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

type Parsed<T> = { value: T } | { error: string };

function parseOptionalDecimal(
  raw: FormDataEntryValue | null,
  label: string,
  options: { maxIntegerDigits: number; maximum?: number; allowZero: boolean },
): Parsed<string | null> {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null };
  }
  if (typeof raw !== "string") {
    return { error: `${label} must have up to two decimal places.` };
  }

  const value = raw.trim();
  const pattern = new RegExp(
    `^\\d{1,${options.maxIntegerDigits}}(?:\\.\\d{1,2})?$`,
  );
  const number = Number(value);
  if (
    !pattern.test(value) ||
    !Number.isFinite(number) ||
    (options.allowZero ? number < 0 : number <= 0) ||
    (options.maximum !== undefined && number > options.maximum)
  ) {
    return {
      error:
        options.maximum !== undefined
          ? `${label} must be greater than 0 and no more than ${options.maximum}.`
          : `${label} must be zero or more with up to two decimal places.`,
    };
  }

  const [whole, fraction = ""] = value.split(".");
  return { value: `${whole}.${fraction.padEnd(2, "0")}` };
}

function parseOptionalDays(
  raw: FormDataEntryValue | null,
  label: string,
): Parsed<number | null> {
  if (raw === null || raw === "") return { value: null };
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return { error: `${label} must be a whole number of days.` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return { error: `${label} must be at least 1 day.` };
  }
  return value <= MAX_COMMISSION_TERM_DAYS
    ? { value }
    : {
        error: `${label} cannot exceed ${MAX_COMMISSION_TERM_DAYS.toLocaleString()} days.`,
      };
}

/** Assigns this Affiliate to a Program and saves its permitted term overrides. */
export async function saveAffiliateSettingsAction(
  product: { id: string; slug: string },
  affiliateId: string,
  formData: FormData,
): Promise<{ success: true } | { error: string }> {
  const ownerId = await owner();
  const programId = String(formData.get("programId") ?? "").trim();
  if (!programId) return { error: "Choose a program before saving." };

  const commissionRate = parseOptionalDecimal(
    formData.get("commissionRateOverride"),
    "Commission rate",
    { maxIntegerDigits: 3, maximum: 100, allowZero: false },
  );
  const minimumPayoutAmount = parseOptionalDecimal(
    formData.get("minimumPayoutAmountOverride"),
    "Minimum payout",
    { maxIntegerDigits: 16, allowZero: true },
  );
  const attributionDays = parseOptionalDays(
    formData.get("attributionWindowDaysOverride"),
    "Time to buy",
  );
  const holdingDays = parseOptionalDays(
    formData.get("holdingPeriodDaysOverride"),
    "Hold before paying",
  );
  if ("error" in commissionRate) return commissionRate;
  if ("error" in minimumPayoutAmount) return minimumPayoutAmount;
  if ("error" in attributionDays) return attributionDays;
  if ("error" in holdingDays) return holdingDays;

  const rawDuration = String(
    formData.get("commissionDurationTypeOverride") ?? "inherit",
  );
  let durationType: CommissionDurationType | null = null;
  let durationMonths: number | null = null;
  if (rawDuration !== "inherit") {
    if (!isCommissionDuration(rawDuration)) {
      return { error: "Choose a valid commission duration." };
    }
    durationType = rawDuration;
    if (durationType === "FIXED_MONTHS") {
      const rawMonths = String(
        formData.get("commissionDurationMonthsOverride") ?? "",
      ).trim();
      if (rawMonths) {
        const months = Number(rawMonths);
        if (
          !/^\d+$/.test(rawMonths) ||
          !Number.isSafeInteger(months) ||
          months < 1
        ) {
          return { error: "Enter a whole number of months, at least 1." };
        }
        if (months > MAX_COMMISSION_DURATION_MONTHS) {
          return {
            error: `Duration cannot exceed ${MAX_COMMISSION_DURATION_MONTHS.toLocaleString()} months.`,
          };
        }
        durationMonths = months;
      }
    }
  }

  const result = await db.$transaction(async (tx) => {
    const affiliate = await tx.affiliate.findFirst({
      where: {
        id: affiliateId,
        merchantId: product.id,
        merchant: { ownerId },
      },
      select: { id: true },
    });
    if (!affiliate) return { error: "Affiliate not found." } as const;

    const program = await tx.program.findFirst({
      where: { id: programId, merchantId: product.id },
      select: {
        id: true,
        commissionDurationType: true,
        commissionDurationMonths: true,
      },
    });
    if (!program)
      return { error: "Choose a program for this product." } as const;
    if (
      durationType === "FIXED_MONTHS" &&
      durationMonths === null &&
      program.commissionDurationType === "FIXED_MONTHS" &&
      program.commissionDurationMonths !== null
    ) {
      // The blank field means "use the Program's current duration". Persist
      // that value so a later Program type change cannot turn this override
      // into a zero-month duration.
      durationMonths = program.commissionDurationMonths;
    }
    if (durationType === "FIXED_MONTHS" && durationMonths === null) {
      return {
        error: "Enter a whole number of months, at least 1.",
      } as const;
    }

    await tx.affiliate.update({
      where: { id: affiliate.id },
      data: { programId: program.id },
    });

    const termOverrides = {
      customCommissionRate: commissionRate.value,
      commissionDurationTypeOverride: durationType,
      commissionDurationMonthsOverride: durationMonths,
      attributionWindowDaysOverride: attributionDays.value,
      holdingPeriodDaysOverride: holdingDays.value,
      minimumPayoutAmountOverride: minimumPayoutAmount.value,
    };
    const hasOverrides = Object.values(termOverrides).some(
      (value) => value !== null,
    );
    if (hasOverrides) {
      await tx.affiliateProgramTerms.upsert({
        where: {
          affiliateId_programId: {
            affiliateId: affiliate.id,
            programId: program.id,
          },
        },
        create: {
          merchantId: product.id,
          affiliateId: affiliate.id,
          programId: program.id,
          ...termOverrides,
        },
        update: termOverrides,
      });
    } else {
      await tx.affiliateProgramTerms.deleteMany({
        where: {
          merchantId: product.id,
          affiliateId: affiliate.id,
          programId: program.id,
        },
      });
    }

    await recalculateAffiliatePayoutEligibility(tx, product.id, affiliate.id);

    return { success: true } as const;
  });

  if ("error" in result) return result;

  revalidatePath(`/dashboard/products/${product.slug}/affiliates`);
  revalidatePath(`/dashboard/products/${product.slug}/commissions`);
  revalidatePath(`/dashboard/products/${product.slug}/payouts`);
  revalidatePath("/affiliates/dashboard");
  return { success: true };
}

/**
 * A one-time link for this affiliate to set a password, for the Owner to send
 * them. Answers the token only; the sheet builds the URL on the product's
 * affiliate domain, where the link has to be opened.
 */
export async function createPasswordLinkAction(
  product: { id: string },
  affiliateId: string,
): Promise<{ token: string } | { error: string }> {
  const ownerId = await owner();
  const token = await createAffiliateResetLink(
    ownerId,
    product.id,
    affiliateId,
  );
  return token ? { token } : { error: "Affiliate not found" };
}
