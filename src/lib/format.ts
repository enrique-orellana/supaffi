import type { CurrencyTotal } from "@/lib/analytics";
import {
  formatCurrencyAmount,
  formatCurrencyAtMinorUnitPrecision,
  formatCurrencySymbol,
} from "@/lib/currency";

/**
 * Money formatting shared by every screen that prints an amount.
 *
 * This formatter handles one amount in one currency at a time. Affiliate
 * dashboards may pass it a presentation-only conversion from `currency.ts`;
 * commission and payout records continue to keep their original currency.
 * The owner dashboard keeps multi-currency totals as one entry per currency.
 *
 * Amounts print with the currency's own symbol and thousands grouping,
 * the way a person writes them: $1,220.00, €60.00, £19.00. A currency the
 * runtime does not know falls back to the code, so a rare one still reads
 * rather than throwing.
 */

/** One amount in one currency: "$1,220.00", "€60.00", "-£5.70". */
export function formatMoney(amount: number | string, currency: string): string {
  return formatCurrencyAmount(amount, currency);
}

/** One amount with the number of fraction digits used by its currency. */
export function formatMoneyAtCurrencyPrecision(
  amount: number | string,
  currency: string,
): string {
  return formatCurrencyAtMinorUnitPrecision(amount, currency);
}

/** The symbol alone, for an axis or a column head: "$", "€", "CHF". */
export function currencySymbol(currency: string): string {
  return formatCurrencySymbol(currency);
}

/**
 * The same list with one currency moved to the front, so the headline
 * figure on a page agrees with the currency its chart is drawn in. Amounts
 * across currencies cannot be ranked, so this is the only honest way to
 * choose which one leads.
 */
export function prefer(
  totals: CurrencyTotal[],
  currency: string | null,
): CurrencyTotal[] {
  if (!currency) return totals;
  const index = totals.findIndex((t) => t.currency === currency);
  if (index <= 0) return totals;
  return [totals[index], ...totals.slice(0, index), ...totals.slice(index + 1)];
}

/**
 * The headline amount of a total. An empty total has no currency of its own,
 * so it borrows `fallback` (the product's usual currency) when the caller
 * knows one, and is a bare 0 when nothing has ever been sold.
 */
export function money(
  totals: CurrencyTotal[],
  fallback?: string | null,
): string {
  if (totals.length === 0) return fallback ? formatMoney(0, fallback) : "0";
  const [first] = totals;
  return formatMoney(first.total, first.currency);
}

export function moneyHint(totals: CurrencyTotal[]): string | undefined {
  if (totals.length < 2) return undefined;
  return totals
    .slice(1)
    .map((t) => formatMoney(t.total, t.currency))
    .join("  ·  ");
}

/** A whole number with thousands grouping: 31,143. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "24 Oct" this year, "24 Oct 2025" any other. */
export function formatDate(date: Date, now: Date = new Date()): string {
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? DAY_MONTH.format(date)
    : DAY_MONTH_YEAR.format(date);
}

/** Two letters for a product's tile: "IG" for Instant Gradient, "MO" for Mockit. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/**
 * A program's terms as one short line, for the affiliate who earns under them:
 * "30% for 12 months · 60-day cookie · 30-day hold".
 */
export function termsLine(terms: {
  rate: number;
  durationType: "ONE_TIME" | "FIXED_MONTHS" | "FOREVER";
  durationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  minimumPayoutAmount: string;
}): string {
  const rate = `${Number(terms.rate.toFixed(2))}%`;
  const earning =
    terms.durationType === "ONE_TIME"
      ? `${rate} of the first payment`
      : terms.durationType === "FIXED_MONTHS"
        ? `${rate} for ${terms.durationMonths ?? 0} months`
        : `${rate} of every payment`;
  return [
    earning,
    `${terms.attributionWindowDays}-day cookie`,
    `${terms.holdingPeriodDays}-day hold`,
    Number(terms.minimumPayoutAmount) > 0
      ? `${terms.minimumPayoutAmount} minimum per currency`
      : "No payout minimum",
  ].join(" · ");
}
