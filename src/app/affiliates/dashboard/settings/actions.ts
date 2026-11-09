"use server";

import { revalidatePath } from "next/cache";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { updateAffiliateDisplayCurrency } from "@/lib/affiliateDisplaySettings";
import {
  normalizeDisplayCurrency,
  PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
} from "@/lib/displayCurrencyOptions";

export type DisplayCurrencySettingsState = {
  error: string;
  saved: boolean;
  savedPreference: string | null;
};

export async function saveAffiliateDisplayCurrencyAction(
  _previous: DisplayCurrencySettingsState,
  formData: FormData,
): Promise<DisplayCurrencySettingsState> {
  // The identity and Merchant scope always come from the authenticated
  // session and current host, never from client-submitted ids.
  const { affiliateId, merchant } = await requireAffiliate();
  const submitted = formData.get("displayCurrency");
  if (typeof submitted !== "string") {
    return {
      error: "Choose a dashboard currency",
      saved: false,
      savedPreference: null,
    };
  }

  const displayCurrency =
    submitted === PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE
      ? null
      : normalizeDisplayCurrency(submitted);
  if (
    submitted !== PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE &&
    !displayCurrency
  ) {
    return {
      error: "Choose a supported dashboard currency",
      saved: false,
      savedPreference: null,
    };
  }

  const updated = await updateAffiliateDisplayCurrency(
    affiliateId,
    merchant.id,
    displayCurrency,
  );
  if (!updated) {
    return {
      error: "Your affiliate profile could not be updated",
      saved: false,
      savedPreference: null,
    };
  }

  revalidatePath("/affiliates/dashboard", "layout");
  return { error: "", saved: true, savedPreference: displayCurrency };
}
