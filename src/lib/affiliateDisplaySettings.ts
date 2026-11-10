import { cache } from "react";
import { db } from "@/lib/db";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/displayCurrencyOptions";

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
