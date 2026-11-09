import { db } from "@/lib/db";
import {
  DEFAULT_DISPLAY_CURRENCY,
  normalizeDisplayCurrency,
  type SupportedDisplayCurrency,
} from "@/lib/displayCurrencyOptions";

/** Read the authenticated Owner's account-wide dashboard display currency. */
export async function getOwnerDisplayCurrency(
  ownerId: string,
): Promise<SupportedDisplayCurrency> {
  const owner = await db.owner.findUnique({
    where: { id: ownerId },
    select: { displayCurrency: true },
  });
  return (
    normalizeDisplayCurrency(owner?.displayCurrency) ?? DEFAULT_DISPLAY_CURRENCY
  );
}

/** Scope the preference update to the authenticated Owner. */
export async function updateOwnerDisplayCurrency(
  ownerId: string,
  displayCurrency: SupportedDisplayCurrency,
): Promise<boolean> {
  const result = await db.owner.updateMany({
    where: { id: ownerId },
    data: { displayCurrency },
  });
  return result.count === 1;
}
