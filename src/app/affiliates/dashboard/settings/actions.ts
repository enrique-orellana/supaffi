"use server";

import { revalidatePath } from "next/cache";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { updateAffiliateSettings } from "@/lib/affiliate";
import {
  normalizeDisplayCurrency,
  PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
} from "@/lib/displayCurrencyOptions";

export type AffiliateSettingsState = {
  error: string;
  saved: boolean;
  savedPayoutDetails: string | null;
  savedDisplayCurrency: string | null;
};

function failed(error: string): AffiliateSettingsState {
  return {
    error,
    saved: false,
    savedPayoutDetails: null,
    savedDisplayCurrency: null,
  };
}

export async function saveAffiliateSettingsAction(
  _previous: AffiliateSettingsState,
  formData: FormData,
): Promise<AffiliateSettingsState> {
  // Always take the affiliate and merchant scope from the authenticated
  // session, never from form data.
  const { affiliateId, merchant } = await requireAffiliate();
  const payoutDetails = formData.get("payoutDetails");
  const submittedCurrency = formData.get("displayCurrency");

  if (typeof payoutDetails !== "string") {
    return failed("Could not save payout details");
  }
  if (typeof submittedCurrency !== "string") {
    return failed("Choose a dashboard currency");
  }

  const displayCurrency =
    submittedCurrency === PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE
      ? null
      : normalizeDisplayCurrency(submittedCurrency);
  if (
    submittedCurrency !== PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE &&
    displayCurrency === null
  ) {
    return failed("Choose a supported dashboard currency");
  }

  const updateError = await updateAffiliateSettings(
    affiliateId,
    merchant.id,
    payoutDetails,
    displayCurrency,
  );
  if (updateError) return failed(updateError.error);

  revalidatePath("/affiliates/dashboard", "layout");
  return {
    error: "",
    saved: true,
    savedPayoutDetails: payoutDetails,
    savedDisplayCurrency: submittedCurrency,
  };
}
