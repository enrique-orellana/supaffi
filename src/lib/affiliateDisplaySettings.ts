import { cache } from "react";
import { db } from "@/lib/db";
import {
  DEFAULT_DISPLAY_CURRENCY,
  type SupportedDisplayCurrency,
} from "@/lib/displayCurrencyOptions";

export type AffiliateDisplaySettings = {
  preference: string | null;
  programDefault: string;
  effectiveCurrency: string;
};

/** Read only the authenticated Affiliate's preference and current Program default. */
export const getAffiliateDisplaySettings = cache(
  async function getAffiliateDisplaySettings(
    affiliateId: string,
    merchantId: string,
  ): Promise<AffiliateDisplaySettings | null> {
    const affiliate = await db.affiliate.findFirst({
      where: { id: affiliateId, merchantId },
      select: {
        displayCurrency: true,
        program: { select: { currency: true } },
      },
    });
    if (!affiliate) return null;

    const programDefault =
      affiliate.program.currency || DEFAULT_DISPLAY_CURRENCY;
    return {
      preference: affiliate.displayCurrency,
      programDefault,
      effectiveCurrency: affiliate.displayCurrency ?? programDefault,
    };
  },
);

/** Scope the write to both the authenticated Affiliate and their current Merchant. */
export async function updateAffiliateDisplayCurrency(
  affiliateId: string,
  merchantId: string,
  displayCurrency: SupportedDisplayCurrency | null,
): Promise<boolean> {
  const result = await db.affiliate.updateMany({
    where: { id: affiliateId, merchantId },
    data: { displayCurrency },
  });
  return result.count === 1;
}
