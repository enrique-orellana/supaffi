import { Prisma, ProviderFeeSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  commissionAfterProviderFee,
  nowPaymentsFeeMinorInCurrency,
} from "@/lib/worker/providerFees";

describe("provider fee adversarial properties", () => {
  it("sums valid NOWPayments fee components exactly in the sale currency", () => {
    const fee = nowPaymentsFeeMinorInCurrency(
      {
        fee: {
          currency: "EUR",
          depositFee: "0.01",
          withdrawalFee: "0.02",
          serviceFee: "1e-2",
        },
      },
      "eur",
      new Prisma.Decimal(200),
    );

    expect(fee?.toString()).toBe("4");
  });

  it("converts an outcome-currency fee by its share of gross settlement", () => {
    const saleMinor = new Prisma.Decimal(200);
    const fee = nowPaymentsFeeMinorInCurrency(
      {
        fee: {
          currency: "usdc",
          depositFee: "0.13616",
          withdrawalFee: "0",
          serviceFee: "0",
        },
        outcome_currency: "USDC",
        outcome_amount: "2.055646",
      },
      "eur",
      saleMinor,
    );

    expect(fee).not.toBeNull();
    const grossOutcome = new Prisma.Decimal("2.055646").plus("0.13616");
    const ratioError = fee!
      .mul(grossOutcome)
      .minus(saleMinor.mul("0.13616"))
      .abs();
    expect(ratioError.lte("0.00000000001")).toBe(true);

    const commission = commissionAfterProviderFee({
      eligibleSaleMinor: saleMinor,
      currency: "eur",
      ratePercent: 20,
      actualFeeMinor: fee,
      fallbackPercent: new Prisma.Decimal(10),
    });
    expect(commission.providerFeeSource).toBe(ProviderFeeSource.ACTUAL);
    expect(commission.providerFeeAmount.toString()).toBe("0.12");
    expect(commission.amount.toString()).toBe("0.38");
  });

  it.each([
    ["negative fee", { fee: { currency: "usd", serviceFee: "-0.01" } }],
    [
      "excessive precision",
      { fee: { currency: "usd", serviceFee: "0.0000000000000000001" } },
    ],
    ["invalid numeric token", { fee: { currency: "usd", serviceFee: "1e99" } }],
    [
      "unsupported fee currency",
      {
        fee: { currency: "btc", serviceFee: "0.1" },
        outcome_currency: "usdc",
        outcome_amount: "2",
      },
    ],
    [
      "missing outcome amount",
      {
        fee: { currency: "usdc", serviceFee: "0.1" },
        outcome_currency: "usdc",
      },
    ],
  ])("rejects %s so the configured fallback is used", (_case, payload) => {
    const actualFee = nowPaymentsFeeMinorInCurrency(
      payload,
      "eur",
      new Prisma.Decimal(10_000),
    );
    expect(actualFee).toBeNull();

    const commission = commissionAfterProviderFee({
      eligibleSaleMinor: 10_000,
      currency: "eur",
      ratePercent: 20,
      actualFeeMinor: actualFee,
      fallbackPercent: new Prisma.Decimal(2),
    });
    expect(commission.providerFeeSource).toBe(ProviderFeeSource.FALLBACK);
    expect(commission.providerFeeAmount.toString()).toBe("2");
    expect(commission.amount.toString()).toBe("19.6");
  });

  it("prefers an actual fee to fallback and never allows a negative commission", () => {
    const result = commissionAfterProviderFee({
      eligibleSaleMinor: 10_000,
      currency: "usd",
      ratePercent: 20,
      actualFeeMinor: 250,
      fallbackPercent: new Prisma.Decimal(90),
    });

    expect(result.providerFeeSource).toBe(ProviderFeeSource.ACTUAL);
    expect(result.providerFeeAmount.toString()).toBe("2.5");
    expect(result.amount.toString()).toBe("19.5");

    const overcharged = commissionAfterProviderFee({
      eligibleSaleMinor: 10_000,
      currency: "usd",
      ratePercent: 20,
      actualFeeMinor: 50_000,
      fallbackPercent: null,
    });
    expect(overcharged.providerFeeAmount.toString()).toBe("100");
    expect(overcharged.amount.toString()).toBe("0");
  });

  it("preserves three-decimal fee detail for currencies that use it", () => {
    const result = commissionAfterProviderFee({
      eligibleSaleMinor: 10_000,
      currency: "kwd",
      ratePercent: 20,
      actualFeeMinor: 3,
      fallbackPercent: null,
    });

    expect(result.providerFeeAmount.toString()).toBe("0.003");
    expect(result.amount.toString()).toBe("2");
  });

  it("keeps fee-adjusted commission within the no-fee commission across bounded inputs", () => {
    const seed = 0x5aff1;
    let state = seed;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };

    for (let index = 0; index < 500; index += 1) {
      const saleMinor = 1 + (next() % 1_000_000);
      const reportedFeeMinor = next() % (saleMinor * 2 + 1);
      const rateBasisPoints = next() % 10_001;
      const ratePercent = new Prisma.Decimal(rateBasisPoints).div(100);
      const context = JSON.stringify({
        seed: `0x${seed.toString(16)}`,
        index,
        saleMinor,
        reportedFeeMinor,
        ratePercent: ratePercent.toString(),
      });

      const noFee = commissionAfterProviderFee({
        eligibleSaleMinor: saleMinor,
        currency: "usd",
        ratePercent,
        actualFeeMinor: null,
        fallbackPercent: null,
      });
      const withFee = commissionAfterProviderFee({
        eligibleSaleMinor: saleMinor,
        currency: "usd",
        ratePercent,
        actualFeeMinor: reportedFeeMinor,
        fallbackPercent: new Prisma.Decimal(100),
      });

      expect(withFee.amount.gte(0), context).toBe(true);
      expect(withFee.amount.lte(noFee.amount), context).toBe(true);
      expect(withFee.providerFeeAmount.gte(0), context).toBe(true);
      expect(
        withFee.providerFeeAmount.lte(new Prisma.Decimal(saleMinor).div(100)),
        context,
      ).toBe(true);
      expect(withFee.providerFeeSource, context).toBe(ProviderFeeSource.ACTUAL);
    }
  });
});
