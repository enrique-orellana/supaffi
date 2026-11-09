// Stripe amounts are integers in a currency's smallest unit, except for a
// documented set of zero-decimal currencies and a few three-decimal ones.
// Keeping this rule in one place also preserves the precision of processor
// fees when they are serialized and displayed.
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function currencyMinorUnitExponent(currency: string): number {
  const cur = currency.toLowerCase();
  if (ZERO_DECIMAL.has(cur)) return 0;
  if (THREE_DECIMAL.has(cur)) return 3;
  return 2;
}
