"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CommissionDurationType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAffiliateResetLink } from "@/lib/affiliatePassword";
import { parseCommissionDurationOverride } from "@/lib/commissionDuration";

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

type ParsedNumber = { value: number | null } | { error: string };

function parseOptionalRate(raw: FormDataEntryValue | null): ParsedNumber {
  if (raw === null || raw === "") return { value: null };
  if (typeof raw !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(raw.trim())) {
    return { error: "Enter a commission rate with up to two decimal places." };
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 100
    ? { value }
    : {
        error: "Commission rates must be greater than 0 and no more than 100%.",
      };
}

function parseOptionalDays(raw: FormDataEntryValue | null): ParsedNumber {
  if (raw === null || raw === "") return { value: null };
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return { error: "Enter a whole number of days." };
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? { value }
    : { error: "Days must be a positive whole number." };
}

type LinkSettings = {
  id: string;
  commissionRate: number | null;
  commissionDurationType: CommissionDurationType | null;
  commissionDurationMonths: number | null;
  attributionWindowDays: number | null;
  holdingPeriodDays: number | null;
};

/** Saves the affiliate's program, rate, and every referral-code override together. */
export async function saveAffiliateSettingsAction(
  product: { id: string; slug: string },
  affiliateId: string,
  formData: FormData,
): Promise<{ success: true } | { error: string }> {
  const ownerId = await owner();
  const programId = String(formData.get("programId") ?? "").trim();
  if (!programId) return { error: "Choose a program before saving." };

  const affiliateRate = parseOptionalRate(formData.get("affiliateRate"));
  if ("error" in affiliateRate) return affiliateRate;

  const rawLinkIds = formData.getAll("linkId");
  if (rawLinkIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    return { error: "Refresh this page and try again." };
  }
  const linkIds = rawLinkIds as string[];
  if (new Set(linkIds).size !== linkIds.length) {
    return { error: "Refresh this page and try again." };
  }

  const links: LinkSettings[] = [];
  for (const id of linkIds) {
    const commissionRate = parseOptionalRate(
      formData.get(`link.${id}.commissionRate`),
    );
    const attributionWindowDays = parseOptionalDays(
      formData.get(`link.${id}.timeToBuy`),
    );
    const holdingPeriodDays = parseOptionalDays(
      formData.get(`link.${id}.holdBeforePaying`),
    );
    if ("error" in commissionRate) return commissionRate;
    if ("error" in attributionWindowDays) return attributionWindowDays;
    if ("error" in holdingPeriodDays) return holdingPeriodDays;

    const rawDuration = String(formData.get(`link.${id}.durationType`) ?? "");
    let commissionDurationType: CommissionDurationType | null = null;
    let commissionDurationMonths: number | null = null;
    if (rawDuration !== "inherit") {
      const duration = parseCommissionDurationOverride(
        rawDuration,
        formData.get(`link.${id}.durationMonths`),
      );
      if (!duration) {
        return {
          error:
            "Choose a commission duration and enter valid months if needed.",
        };
      }
      commissionDurationType = duration.type;
      commissionDurationMonths = duration.months;
    }

    links.push({
      id,
      commissionRate: commissionRate.value,
      commissionDurationType,
      commissionDurationMonths,
      attributionWindowDays: attributionWindowDays.value,
      holdingPeriodDays: holdingPeriodDays.value,
    });
  }

  const result = await db.$transaction(async (tx) => {
    const affiliate = await tx.affiliate.findFirst({
      where: {
        id: affiliateId,
        merchantId: product.id,
        merchant: { ownerId },
      },
      select: { id: true, links: { select: { id: true } } },
    });
    if (!affiliate) return { error: "Affiliate not found." } as const;

    const ownedLinkIds = new Set(affiliate.links.map((link) => link.id));
    if (
      ownedLinkIds.size !== linkIds.length ||
      linkIds.some((id) => !ownedLinkIds.has(id))
    ) {
      return { error: "Refresh this page and try again." } as const;
    }

    const program = await tx.program.findFirst({
      where: { id: programId, merchantId: product.id },
      select: { id: true },
    });
    if (!program)
      return { error: "Choose a program for this product." } as const;

    await tx.affiliate.update({
      where: { id: affiliate.id },
      data: {
        programId: program.id,
        customCommissionRate: affiliateRate.value,
      },
    });

    for (const link of links) {
      await tx.affiliateLink.update({
        where: { id: link.id },
        data: {
          commissionRateOverride: link.commissionRate,
          commissionDurationTypeOverride: link.commissionDurationType,
          commissionDurationMonthsOverride: link.commissionDurationMonths,
          attributionWindowDaysOverride: link.attributionWindowDays,
          holdingPeriodDaysOverride: link.holdingPeriodDays,
        },
      });
    }

    return { success: true } as const;
  });

  if ("error" in result) return result;

  revalidatePath(`/dashboard/products/${product.slug}/affiliates`);
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
