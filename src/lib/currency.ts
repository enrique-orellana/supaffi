import Decimal from "decimal.js";

const MONEY_DECIMAL = Decimal.clone({
  precision: 48,
  rounding: Decimal.ROUND_HALF_UP,
});

const REFERENCE_RATE_SECONDS = 86_400;
const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates";

export type EcbReferenceRates = {
  base: "eur";
  rateDate: string | null;
  rates: Readonly<Record<string, string>>;
};

export type CurrencyTotalInput = {
  currency: string;
  total: Decimal.Value;
};

export type ConvertedCurrencyTotal = {
  targetCurrency: string;
  /** Null means no source amount could be converted to the target currency. */
  total: string | null;
  /** Source amounts with no usable reference rate; never mixed into `total`. */
  unconverted: { currency: string; total: string }[];
  /** True when at least one total used an exchange rate. */
  isEstimate: boolean;
  /** True when some source amounts could not be converted. */
  isPartial: boolean;
  rateDate: string | null;
};

export type CurrencyChartInput = {
  date: string;
  amounts: Record<
    string,
    { gross: Decimal.Value; commission: Decimal.Value; sales: number }
  >;
};

export type ConvertedCurrencyChartPoint = {
  date: string;
  gross: string | null;
  commission: string | null;
  sales: number;
  unconverted: {
    currency: string;
    gross: string;
    commission: string;
    sales: number;
  }[];
  isEstimate: boolean;
  rateDate: string | null;
};

const EMPTY_ECB_REFERENCE_RATES: EcbReferenceRates = {
  base: "eur",
  rateDate: null,
  rates: { eur: "1" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Read the ECB reference-rate snapshot from Frankfurter. Next caches the
 * response for at most one day. Failures produce a usable EUR-only snapshot:
 * same-currency amounts still work and every other source amount is surfaced
 * as unconverted by the helpers below.
 */
export async function getEcbReferenceRates(): Promise<EcbReferenceRates> {
  const url = new URL(FRANKFURTER_URL);
  url.searchParams.set("base", "eur");
  url.searchParams.set("providers", "ecb");

  try {
    const response = await fetch(url, {
      next: { revalidate: REFERENCE_RATE_SECONDS },
    });
    if (!response.ok) return EMPTY_ECB_REFERENCE_RATES;

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return EMPTY_ECB_REFERENCE_RATES;

    const rows = payload.filter(
      (row): row is Record<string, unknown> =>
        isRecord(row) &&
        typeof row.base === "string" &&
        row.base.toLowerCase() === "eur" &&
        typeof row.quote === "string" &&
        typeof row.rate === "number" &&
        Number.isFinite(row.rate) &&
        row.rate > 0 &&
        isIsoDate(row.date),
    );
    const dates = new Set(rows.map((row) => row.date as string));
    if (rows.length === 0 || dates.size !== 1) return EMPTY_ECB_REFERENCE_RATES;

    const rates: Record<string, string> = { eur: "1" };
    for (const row of rows) {
      const quote = (row.quote as string).toLowerCase();
      rates[quote] = String(row.rate);
    }

    return {
      base: "eur",
      rateDate: dates.values().next().value ?? null,
      rates,
    };
  } catch {
    return EMPTY_ECB_REFERENCE_RATES;
  }
}

function parseDecimal(value: Decimal.Value): Decimal | null {
  try {
    const amount = new MONEY_DECIMAL(value);
    return amount.isFinite() ? amount : null;
  } catch {
    return null;
  }
}

function rateFor(currency: string, rates: EcbReferenceRates): Decimal | null {
  const rate = rates.rates[currency.toLowerCase()];
  if (!rate) return null;
  const parsed = parseDecimal(rate);
  return parsed?.gt(0) ? parsed : null;
}

function convertDecimal(
  amount: Decimal,
  sourceCurrency: string,
  targetCurrency: string,
  rates: EcbReferenceRates,
): { amount: Decimal; estimated: boolean } | null {
  const source = sourceCurrency.trim().toLowerCase();
  const target = targetCurrency.trim().toLowerCase();
  if (source === target) return { amount, estimated: false };

  const sourceRate = rateFor(source, rates);
  const targetRate = rateFor(target, rates);
  if (!sourceRate || !targetRate) return null;

  // Frankfurter's EUR-base rate is quote units per one EUR.
  return {
    amount: amount.div(sourceRate).mul(targetRate),
    estimated: true,
  };
}

function decimalString(value: Decimal, currency: string): string {
  return value.toFixed(
    currencyMinorUnitExponent(currency),
    Decimal.ROUND_HALF_UP,
  );
}

/**
 * Convert already-grouped source totals into one target total. Values are
 * merged and converted with decimal arithmetic, then rounded once at the
 * target currency's minor-unit precision. Missing rates remain separate.
 */
export function convertCurrencyTotals(
  totals: readonly CurrencyTotalInput[],
  targetCurrency: string,
  rates: EcbReferenceRates,
): ConvertedCurrencyTotal {
  const target = targetCurrency.trim().toLowerCase();
  const byCurrency = new Map<string, Decimal>();
  const invalid: { currency: string; total: string }[] = [];

  for (const row of totals) {
    const currency = row.currency.trim().toLowerCase();
    const amount = parseDecimal(row.total);
    if (!currency || !amount) {
      invalid.push({
        currency: row.currency.toUpperCase(),
        total: String(row.total),
      });
      continue;
    }
    byCurrency.set(
      currency,
      (byCurrency.get(currency) ?? new MONEY_DECIMAL(0)).plus(amount),
    );
  }

  let converted = new MONEY_DECIMAL(0);
  let convertedCount = 0;
  let isEstimate = false;
  const unconverted = [...invalid];

  for (const [currency, amount] of byCurrency) {
    const result = convertDecimal(amount, currency, target, rates);
    if (!result) {
      unconverted.push({
        currency: currency.toUpperCase(),
        total: decimalString(amount, currency),
      });
      continue;
    }
    converted = converted.plus(result.amount);
    convertedCount += 1;
    isEstimate ||= result.estimated;
  }

  const total =
    convertedCount === 0 && byCurrency.size + invalid.length > 0
      ? null
      : decimalString(converted, target);

  return {
    targetCurrency: target.toUpperCase(),
    total,
    unconverted: unconverted.sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    isEstimate,
    isPartial: unconverted.length > 0,
    rateDate: isEstimate ? rates.rateDate : null,
  };
}

/**
 * Convert each chart bucket from its grouped source currencies. The output
 * contains only target-currency values; any source amount without a rate is
 * preserved in `unconverted` for the chart tooltip or adjacent breakdown.
 */
export function convertCurrencyChart(
  series: readonly CurrencyChartInput[],
  targetCurrency: string,
  rates: EcbReferenceRates,
): ConvertedCurrencyChartPoint[] {
  return series.map((point) => {
    const grossRows = Object.entries(point.amounts).map(
      ([currency, value]) => ({
        currency,
        total: value.gross,
      }),
    );
    const commissionRows = Object.entries(point.amounts).map(
      ([currency, value]) => ({ currency, total: value.commission }),
    );
    const gross = convertCurrencyTotals(grossRows, targetCurrency, rates);
    const commission = convertCurrencyTotals(
      commissionRows,
      targetCurrency,
      rates,
    );

    const unconvertedCurrencies = new Set([
      ...gross.unconverted.map((row) => row.currency),
      ...commission.unconverted.map((row) => row.currency),
    ]);
    const unconverted = [...unconvertedCurrencies]
      .sort((a, b) => a.localeCompare(b))
      .map((currency) => {
        const key = currency.toLowerCase();
        const values = point.amounts[key] ?? point.amounts[currency];
        const sourceCurrency = values ? key : currency;
        const amount = values ?? { gross: "0", commission: "0", sales: 0 };
        return {
          currency,
          gross: decimalString(
            parseDecimal(amount.gross) ?? new MONEY_DECIMAL(0),
            sourceCurrency,
          ),
          commission: decimalString(
            parseDecimal(amount.commission) ?? new MONEY_DECIMAL(0),
            sourceCurrency,
          ),
          sales: amount.sales,
        };
      });

    return {
      date: point.date,
      gross: gross.total,
      commission: commission.total,
      sales: Object.values(point.amounts).reduce(
        (total, amount) => total + amount.sales,
        0,
      ),
      unconverted,
      isEstimate: gross.isEstimate || commission.isEstimate,
      rateDate: gross.rateDate ?? commission.rateDate,
    };
  });
}

/** Formats a currency amount at an explicit fraction-digit precision. */
export function formatCurrencyAmount(
  amount: Decimal.Value,
  currency: string,
  fractionDigits = 2,
): string {
  const value = parseDecimal(amount);
  const code = currency.toUpperCase();
  if (!value) return `${String(amount)} ${code}`;

  const digits = Math.max(0, Math.min(20, Math.floor(fractionDigits)));
  const fixed = value.toFixed(digits, Decimal.ROUND_HALF_UP);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    return `${fixed} ${code}`;
  }

  const negative = value.isNegative();
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integer, fraction = ""] = unsigned.split(".");
  const groupingParts = new Intl.NumberFormat("en", {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).formatToParts(1000);
  const groupSeparator =
    groupingParts.find((part) => part.type === "group")?.value ?? ",";
  const groupedInteger = integer.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    groupSeparator,
  );
  const template = formatter.formatToParts(negative ? -1 : 1);
  let insertedInteger = false;
  const output: string[] = [];

  for (const part of template) {
    if (part.type === "integer") {
      if (!insertedInteger) output.push(groupedInteger);
      insertedInteger = true;
    } else if (part.type === "group") {
      // The exact integer grouping was inserted above from the decimal string.
    } else if (part.type === "fraction") {
      output.push(fraction);
    } else if (part.type === "decimal") {
      if (digits > 0) output.push(part.value);
    } else {
      output.push(part.value);
    }
  }

  return output.join("");
}

/** Formats with the standard minor-unit precision for the currency. */
export function formatCurrencyAtMinorUnitPrecision(
  amount: Decimal.Value,
  currency: string,
): string {
  return formatCurrencyAmount(
    amount,
    currency,
    currencyMinorUnitExponent(currency),
  );
}

/** The narrow currency symbol, or the ISO code when Intl does not know it. */
export function formatCurrencySymbol(currency: string): string {
  const code = currency.toUpperCase();
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: code,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? code
    );
  } catch {
    return code;
  }
}

/** A compact user-facing rate note for values converted with reference rates. */
export function formatReferenceRateLabel(rateDate: string | null): string {
  if (!rateDate || !isIsoDate(rateDate))
    return "Estimated using ECB reference rates";
  const date = new Date(`${rateDate}T00:00:00.000Z`);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `Estimated · ECB reference rates from ${formatted}`;
}

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
