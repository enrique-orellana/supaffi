import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  attributionExpiry,
  clickCommissionTermSnapshot,
  resolveClickCommissionTerms,
  resolveCurrentCommissionTerms,
  resolveMinimumPayoutAmount,
  type CommissionTermAffiliate,
  type CommissionTermProgram,
} from "@/lib/commissionTerms";

function program(
  overrides: Partial<CommissionTermProgram> = {},
): CommissionTermProgram {
  return {
    id: "program-1",
    defaultCommissionRate: new Prisma.Decimal("20"),
    commissionDurationType: "FIXED_MONTHS",
    commissionDurationMonths: 2,
    attributionWindowDays: 60,
    holdingPeriodDays: 30,
    minimumPayoutAmount: new Prisma.Decimal("50"),
    ...overrides,
  };
}

function affiliate(
  overrides: Partial<CommissionTermAffiliate> = {},
): CommissionTermAffiliate {
  return {
    programId: "program-1",
    customCommissionRate: null,
    commissionDurationTypeOverride: null,
    commissionDurationMonthsOverride: null,
    attributionWindowDaysOverride: null,
    holdingPeriodDaysOverride: null,
    minimumPayoutAmountOverride: null,
    ...overrides,
  };
}

describe("commission term resolution", () => {
  it("uses Affiliate overrides for assigned Program terms", () => {
    const terms = resolveCurrentCommissionTerms(
      program(),
      affiliate({
        customCommissionRate: new Prisma.Decimal("35.5"),
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 6,
        attributionWindowDaysOverride: 14,
        minimumPayoutAmountOverride: new Prisma.Decimal("80"),
      }),
    );

    expect(terms).toEqual({
      commissionRate: new Prisma.Decimal("35.5"),
      commissionRateSource: "affiliate",
      commissionDuration: {
        commissionDurationType: "FIXED_MONTHS",
        commissionDurationMonths: 6,
      },
      attributionWindowDays: 14,
      holdingPeriodDays: 30,
      minimumPayoutAmount: new Prisma.Decimal("80"),
    });
  });

  it("does not apply an affiliate override after they move to another program", () => {
    const terms = resolveCurrentCommissionTerms(
      program(),
      affiliate({
        programId: "program-2",
        customCommissionRate: new Prisma.Decimal("35"),
        commissionDurationTypeOverride: "ONE_TIME",
        attributionWindowDaysOverride: 14,
        holdingPeriodDaysOverride: 7,
        minimumPayoutAmountOverride: new Prisma.Decimal("80"),
      }),
    );

    expect(terms.commissionRate.toString()).toBe("20");
    expect(terms.commissionDuration).toEqual({
      commissionDurationType: "FIXED_MONTHS",
      commissionDurationMonths: 2,
    });
    expect(terms.attributionWindowDays).toBe(60);
    expect(terms.holdingPeriodDays).toBe(30);
    expect(terms.minimumPayoutAmount.toString()).toBe("50");
  });

  it("inherits the Program month count when only the duration type is overridden", () => {
    const terms = resolveCurrentCommissionTerms(
      program({ commissionDurationMonths: 12 }),
      affiliate({
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: null,
      }),
    );

    expect(terms.commissionDuration).toEqual({
      commissionDurationType: "FIXED_MONTHS",
      commissionDurationMonths: 12,
    });
  });

  it("keeps the terms captured by a click when current program terms change", () => {
    const terms = resolveClickCommissionTerms(
      program({
        defaultCommissionRate: new Prisma.Decimal("25"),
        commissionDurationType: "FOREVER",
        commissionDurationMonths: null,
        holdingPeriodDays: 45,
      }),
      affiliate({
        customCommissionRate: new Prisma.Decimal("35"),
        commissionDurationTypeOverride: "ONE_TIME",
        holdingPeriodDaysOverride: 7,
      }),
      {
        commissionRateSnapshot: new Prisma.Decimal("12.5"),
        commissionDurationTypeSnapshot: "FIXED_MONTHS",
        commissionDurationMonthsSnapshot: 4,
        holdingPeriodDaysSnapshot: 3,
      },
    );

    expect(terms).toEqual({
      commissionRate: new Prisma.Decimal("12.5"),
      commissionDuration: {
        commissionDurationType: "FIXED_MONTHS",
        commissionDurationMonths: 4,
      },
      holdingPeriodDays: 3,
    });
  });

  it("uses current affiliate terms for legacy clicks without snapshots", () => {
    const terms = resolveClickCommissionTerms(
      program(),
      affiliate({
        customCommissionRate: new Prisma.Decimal("35"),
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 8,
        holdingPeriodDaysOverride: 5,
      }),
      {
        commissionRateSnapshot: null,
        commissionDurationTypeSnapshot: null,
        commissionDurationMonthsSnapshot: null,
        holdingPeriodDaysSnapshot: null,
      },
    );

    expect(terms).toEqual({
      commissionRate: new Prisma.Decimal("35"),
      commissionDuration: {
        commissionDurationType: "FIXED_MONTHS",
        commissionDurationMonths: 8,
      },
      holdingPeriodDays: 5,
    });
  });

  it("uses an Affiliate minimum only for its assigned Program", () => {
    const programMinimum = program();
    const affiliateMinimum = affiliate({
      minimumPayoutAmountOverride: new Prisma.Decimal("0"),
    });

    expect(
      resolveMinimumPayoutAmount(programMinimum, affiliateMinimum).toString(),
    ).toBe("0");
    expect(
      resolveMinimumPayoutAmount(
        programMinimum,
        affiliate({
          programId: "program-2",
          minimumPayoutAmountOverride: new Prisma.Decimal("0"),
        }),
      ).toString(),
    ).toBe("50");
  });

  it("stores the resolved commission terms and the attribution expiry on a click", () => {
    const createdAt = new Date("2026-11-10T12:00:00.000Z");
    const terms = resolveCurrentCommissionTerms(
      program(),
      affiliate({
        customCommissionRate: new Prisma.Decimal("35"),
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: 3,
        attributionWindowDaysOverride: 14,
        holdingPeriodDaysOverride: 7,
      }),
    );

    expect(clickCommissionTermSnapshot(terms)).toEqual({
      commissionRateSnapshot: new Prisma.Decimal("35"),
      commissionDurationTypeSnapshot: "FIXED_MONTHS",
      commissionDurationMonthsSnapshot: 3,
      holdingPeriodDaysSnapshot: 7,
    });
    expect(attributionExpiry(createdAt, terms.attributionWindowDays)).toEqual(
      new Date("2026-11-24T12:00:00.000Z"),
    );
  });
});
