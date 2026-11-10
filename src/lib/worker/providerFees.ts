import { Prisma, ProviderFeeSource } from "@prisma/client";
import { currencyMinorUnitExponent } from "@/lib/currency";

export type ActualProviderFee = {
  amountMinor: number;
  currency: string;
  /** Provider's conversion rate from the charged currency to its balance currency. */
  exchangeRate?: number | null;
};

/** Convert a provider fee to the sale currency without floating-point rounding. */
export function feeMinorInCurrency(
  fee: ActualProviderFee,
  targetCurrency: string,
): number | null {
  if (!Number.isSafeInteger(fee.amountMinor) || fee.amountMinor < 0)
    return null;
  if (fee.currency.toLowerCase() === targetCurrency.toLowerCase())
    return fee.amountMinor;
  if (
    typeof fee.exchangeRate !== "number" ||
    !Number.isFinite(fee.exchangeRate) ||
    fee.exchangeRate <= 0
  )
    return null;

  // Stripe defines exchange_rate as charge currency × rate = balance
  // currency. Convert the fee back into the charge currency before allocation.
  const sourceScale = 10 ** currencyMinorUnitExponent(fee.currency);
  const targetScale = 10 ** currencyMinorUnitExponent(targetCurrency);
  return new Prisma.Decimal(fee.amountMinor)
    .div(sourceScale)
    .div(fee.exchangeRate)
    .mul(targetScale)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

function nowPaymentsDecimal(value: unknown): Prisma.Decimal | null {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?(?:[eE][+-]?\d{1,2})?$/.test(value)
  )
    return null;

  const amount = new Prisma.Decimal(value);
  if (amount.isNegative()) return null;
  const [integer, fraction = ""] = amount.toFixed().split(".");
  if (integer.length > 20 || fraction.length > 18) return null;
  return amount;
}

/**
 * Read signed NOWPayments fee components. When fees use the outcome currency,
 * translate them to the sale currency by their share of the gross settlement:
 * outcome_amount is the net amount received after fees.
 */
export function nowPaymentsFeeMinorInCurrency(
  rawPayload: Record<string, unknown>,
  saleCurrency: string,
  eligibleSaleMinor: number | Prisma.Decimal,
): Prisma.Decimal | null {
  const fee = rawPayload.fee;
  if (!fee || typeof fee !== "object" || Array.isArray(fee)) return null;
  const feeObject = fee as Record<string, unknown>;
  const feeCurrency = feeObject.currency;
  if (
    typeof feeCurrency !== "string" ||
    !/^[a-z0-9_-]{2,20}$/i.test(feeCurrency)
  )
    return null;

  const componentNames = ["depositFee", "withdrawalFee", "serviceFee"] as const;
  let total = new Prisma.Decimal(0);
  let foundComponent = false;
  for (const name of componentNames) {
    const value = feeObject[name];
    if (value === undefined || value === null) continue;
    const amount = nowPaymentsDecimal(value);
    if (amount === null) return null;
    total = total.plus(amount);
    foundComponent = true;
  }
  if (!foundComponent) return null;

  const saleScale = 10 ** currencyMinorUnitExponent(saleCurrency);
  if (feeCurrency.toLowerCase() === saleCurrency.toLowerCase())
    return total.mul(saleScale);

  const outcomeCurrency = rawPayload.outcome_currency;
  const outcomeAmount = nowPaymentsDecimal(rawPayload.outcome_amount);
  if (
    typeof outcomeCurrency !== "string" ||
    feeCurrency.toLowerCase() !== outcomeCurrency.toLowerCase() ||
    outcomeAmount === null ||
    outcomeAmount.lte(0)
  )
    return null;

  const grossOutcome = outcomeAmount.plus(total);
  if (grossOutcome.lte(0)) return null;

  return total
    .div(grossOutcome)
    .mul(eligibleSaleMinor)
    .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Subtract the payment provider's fee from referred sale revenue, then apply
 * the affiliate rate. Stripe's fee is allocated by the referred share of the
 * full charge; invoice providers can pass the fee for the referred sale.
 */
export function commissionAfterProviderFee(input: {
  eligibleSaleMinor: number | Prisma.Decimal;
  currency: string;
  ratePercent: number | Prisma.Decimal;
  actualFeeMinor: number | Prisma.Decimal | null;
  fallbackPercent: Prisma.Decimal | null;
  chargedAmountMinor?: number | Prisma.Decimal | null;
}): {
  amount: Prisma.Decimal;
  providerFeeAmount: Prisma.Decimal;
  providerFeePercent: Prisma.Decimal | null;
  providerFeeSource: ProviderFeeSource | null;
} {
  const roundedEligibleSaleMinor = new Prisma.Decimal(
    input.eligibleSaleMinor,
  ).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const eligibleSaleMinor = roundedEligibleSaleMinor.lt(0)
    ? new Prisma.Decimal(0)
    : roundedEligibleSaleMinor;
  let feeMinor: Prisma.Decimal | null = null;
  let providerFeeSource: ProviderFeeSource | null = null;

  if (input.actualFeeMinor !== null) {
    feeMinor = new Prisma.Decimal(input.actualFeeMinor);
    providerFeeSource = ProviderFeeSource.ACTUAL;
    if (
      input.chargedAmountMinor !== undefined &&
      input.chargedAmountMinor !== null &&
      new Prisma.Decimal(input.chargedAmountMinor).gt(0)
    ) {
      feeMinor = feeMinor.mul(eligibleSaleMinor).div(input.chargedAmountMinor);
    }
  } else if (input.fallbackPercent !== null) {
    feeMinor = eligibleSaleMinor.mul(input.fallbackPercent).div(100);
    providerFeeSource = ProviderFeeSource.FALLBACK;
  }

  const roundedFeeMinor = (feeMinor ?? new Prisma.Decimal(0)).toDecimalPlaces(
    0,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  const boundedFeeMinor = roundedFeeMinor.lt(0)
    ? new Prisma.Decimal(0)
    : roundedFeeMinor.gt(eligibleSaleMinor)
      ? eligibleSaleMinor
      : roundedFeeMinor;
  const minorUnitScale = 10 ** currencyMinorUnitExponent(input.currency);
  const netSaleAmount = eligibleSaleMinor
    .minus(boundedFeeMinor)
    .div(minorUnitScale);
  const providerFeeAmount = boundedFeeMinor
    .div(minorUnitScale)
    .toDecimalPlaces(
      currencyMinorUnitExponent(input.currency),
      Prisma.Decimal.ROUND_HALF_UP,
    );
  const providerFeePercent =
    providerFeeSource === null || eligibleSaleMinor.lte(0)
      ? null
      : boundedFeeMinor
          .mul(100)
          .div(eligibleSaleMinor)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

  return {
    amount: netSaleAmount
      .mul(input.ratePercent)
      .div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    providerFeeAmount,
    providerFeePercent,
    providerFeeSource,
  };
}
