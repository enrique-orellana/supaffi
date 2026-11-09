/**
 * Client-safe display-currency choices shared by program settings,
 * affiliate preferences, and server-side validation.
 */
export const SUPPORTED_DISPLAY_CURRENCY_CODES = [
  "usd",
  "gbp",
  "cad",
  "eur",
  "aud",
  "nzd",
] as const;

export type SupportedDisplayCurrency =
  (typeof SUPPORTED_DISPLAY_CURRENCY_CODES)[number];

export const DEFAULT_DISPLAY_CURRENCY =
  "eur" satisfies SupportedDisplayCurrency;

export const PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE = "__program_default__";

export const DISPLAY_CURRENCY_OPTIONS = SUPPORTED_DISPLAY_CURRENCY_CODES.map(
  (code) => ({
    code,
    label: code.toUpperCase(),
  }),
) satisfies { code: SupportedDisplayCurrency; label: string }[];

const supportedCurrencies = new Set<string>(SUPPORTED_DISPLAY_CURRENCY_CODES);

/** Normalizes an untrusted currency value to a supported lowercase code. */
export function normalizeDisplayCurrency(
  value: unknown,
): SupportedDisplayCurrency | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return supportedCurrencies.has(normalized)
    ? (normalized as SupportedDisplayCurrency)
    : null;
}
