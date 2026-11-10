import { Prisma, ProviderFeeSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { currencyMinorUnitExponent } from "@/lib/currency";
import {
  commissionAfterProviderFee,
  nowPaymentsFeeMinorInCurrency,
  resolveProviderFee,
} from "@/lib/worker/providerFees";

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

describe("provider fee resolution adversarial properties", () => {
  it("matches exact cent-floor arithmetic for bounded inputs across currency precisions", () => {
    const seed = 0x71f33;
    const random = seededRandom(seed);
    const currencies = ["JPY", "USD", "KWD"];

    for (let index = 0; index < 600; index += 1) {
      const currency = currencies[index % currencies.length]!;
      const exponent = currencyMinorUnitExponent(currency);
      const saleMinor = random() % 2_000_001;
      const actualFeeMinor = random() % (saleMinor * 3 + 1 || 1);
      const rateBasisPoints = random() % 10_001;
      const cappedFeeMinor = Math.min(actualFeeMinor, saleMinor);
      const netSaleMinor = saleMinor - cappedFeeMinor;
      const expectedCents =
        (BigInt(netSaleMinor) * BigInt(rateBasisPoints)) /
        (10n ** BigInt(exponent) * 100n);
      const expectedCommission = new Prisma.Decimal(
        expectedCents.toString(),
      ).div(100);
      const expectedFee = new Prisma.Decimal(cappedFeeMinor).div(
        10 ** exponent,
      );
      const ratePercent = new Prisma.Decimal(rateBasisPoints).div(100);
      const context = JSON.stringify({
        seed: `0x${seed.toString(16)}`,
        index,
        currency,
        saleMinor,
        actualFeeMinor,
        rateBasisPoints,
      });

      const withFee = commissionAfterProviderFee({
        eligibleSaleMinor: saleMinor,
        currency,
        ratePercent,
        actualFeeMinor,
        fallbackPercent: new Prisma.Decimal(100),
      });
      const noFee = commissionAfterProviderFee({
        eligibleSaleMinor: saleMinor,
        currency,
        ratePercent,
        actualFeeMinor: null,
        fallbackPercent: null,
      });

      expect(withFee.amount.toFixed(2), context).toBe(
        expectedCommission.toFixed(2),
      );
      expect(withFee.providerFeeAmount.toFixed(exponent), context).toBe(
        expectedFee.toFixed(exponent),
      );
      expect(withFee.providerFeeSource, context).toBe(ProviderFeeSource.ACTUAL);
      expect(withFee.amount.gte(0), context).toBe(true);
      expect(withFee.amount.lte(noFee.amount), context).toBe(true);
      expect(
        withFee.providerFeeAmount.lte(
          new Prisma.Decimal(saleMinor).div(10 ** exponent),
        ),
        context,
      ).toBe(true);
    }
  });

  it("rounds fallback fees to minor units before applying the commission", () => {
    const seed = 0x4fa11;
    const random = seededRandom(seed);
    const currencies = ["JPY", "USD", "KWD"];

    for (let index = 0; index < 300; index += 1) {
      const currency = currencies[index % currencies.length]!;
      const exponent = currencyMinorUnitExponent(currency);
      const saleMinor = 1 + (random() % 1_000_000);
      const fallbackBasisPoints = random() % 10_001;
      const rateBasisPoints = random() % 10_001;
      const roundedFeeMinor =
        (BigInt(saleMinor) * BigInt(fallbackBasisPoints) + 5_000n) / 10_000n;
      const cappedFeeMinor = Number(
        roundedFeeMinor > BigInt(saleMinor)
          ? BigInt(saleMinor)
          : roundedFeeMinor,
      );
      const netSaleMinor = saleMinor - cappedFeeMinor;
      const expectedCents =
        (BigInt(netSaleMinor) * BigInt(rateBasisPoints)) /
        (10n ** BigInt(exponent) * 100n);
      const ratePercent = new Prisma.Decimal(rateBasisPoints).div(100);
      const fallbackPercent = new Prisma.Decimal(fallbackBasisPoints).div(100);
      const result = commissionAfterProviderFee({
        eligibleSaleMinor: saleMinor,
        currency,
        ratePercent,
        actualFeeMinor: null,
        fallbackPercent,
      });
      const context = JSON.stringify({
        seed: `0x${seed.toString(16)}`,
        index,
        currency,
        saleMinor,
        fallbackBasisPoints,
        rateBasisPoints,
      });

      expect(result.providerFeeSource, context).toBe(
        ProviderFeeSource.FALLBACK,
      );
      expect(result.providerFeeAmount.toFixed(exponent), context).toBe(
        new Prisma.Decimal(cappedFeeMinor)
          .div(10 ** exponent)
          .toFixed(exponent),
      );
      expect(result.amount.toFixed(2), context).toBe(
        new Prisma.Decimal(expectedCents.toString()).div(100).toFixed(2),
      );
    }
  });

  it("does not throw on bounded malformed fee strings or non-string component values", () => {
    const seed = 0x5eed;
    const random = seededRandom(seed);
    const alphabet = "0123456789eE.+-abc_";

    for (let index = 0; index < 500; index += 1) {
      const length = random() % 32;
      let value = "";
      for (let character = 0; character < length; character += 1) {
        value += alphabet[random() % alphabet.length];
      }

      const candidates: unknown[] = [
        value,
        random() % 100,
        null,
        [],
        { amount: value },
      ];
      const component = candidates[index % candidates.length];
      const context = JSON.stringify({
        seed: `0x${seed.toString(16)}`,
        index,
        component,
      });

      const fee = nowPaymentsFeeMinorInCurrency(
        { fee: { currency: "USD", serviceFee: component } },
        "USD",
        10_000,
      );

      expect(fee === null || (fee.isFinite() && fee.gte(0)), context).toBe(
        true,
      );
    }
  });

  it("uses an actual zero fee instead of a nonzero fallback estimate", () => {
    const resolved = resolveProviderFee({
      eligibleSaleMinor: 12_345,
      currency: "USD",
      actualFeeMinor: 0,
      fallbackPercent: new Prisma.Decimal(50),
    });

    expect(resolved.providerFeeSource).toBe(ProviderFeeSource.ACTUAL);
    expect(resolved.feeMinor.toString()).toBe("0");
    expect(resolved.providerFeeAmount.toString()).toBe("0");
  });
});
