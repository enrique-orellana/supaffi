import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import {
  getPayoutEligibility,
  getProgramMinimumImpact,
} from "@/lib/payoutEligibility";

const GROUP = {
  merchantId: "merchant-1",
  affiliateId: "affiliate-1",
  programId: "program-1",
  currency: "usd",
};

describe("getProgramMinimumImpact", () => {
  it("does not warn about affiliates whose payout minimum is overridden", async () => {
    const client = {
      commission: {
        groupBy: vi.fn().mockResolvedValue([
          {
            affiliateId: "no-minimum",
            currency: "usd",
            status: COMMISSION_STATUS.PAYABLE,
            _sum: { amount: new Prisma.Decimal("50") },
          },
          {
            affiliateId: "program-minimum",
            currency: "usd",
            status: COMMISSION_STATUS.PAYABLE,
            _sum: { amount: new Prisma.Decimal("50") },
          },
        ]),
      },
      affiliate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "no-minimum",
            name: "No minimum",
          },
          {
            id: "program-minimum",
            name: "Program minimum",
          },
        ]),
      },
      affiliateProgramTerms: {
        findMany: vi.fn().mockResolvedValue([
          {
            affiliateId: "no-minimum",
            programId: "program-1",
            minimumPayoutAmountOverride: new Prisma.Decimal("0"),
          },
          {
            affiliateId: "program-minimum",
            programId: "program-1",
            minimumPayoutAmountOverride: null,
          },
        ]),
      },
    };

    const impact = await getProgramMinimumImpact(
      "merchant-1",
      "program-1",
      "100",
      new Date("2026-11-10T12:00:00.000Z"),
      client as unknown as Parameters<typeof getProgramMinimumImpact>[4],
    );

    expect(impact).toEqual([
      {
        affiliateId: "program-minimum",
        affiliateName: "Program minimum",
        currency: "usd",
        eligibleBalance: "50.00",
        currentlyPayable: "50.00",
      },
    ]);
  });
});

describe("getPayoutEligibility", () => {
  it("uses the assigned Affiliate's payout minimum override", async () => {
    const client = {
      program: {
        findFirst: vi.fn().mockResolvedValue({
          id: "program-1",
          minimumPayoutAmount: new Prisma.Decimal("100"),
        }),
      },
      affiliate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "affiliate-1",
        }),
      },
      affiliateProgramTerms: {
        findUnique: vi.fn().mockResolvedValue({
          affiliateId: "affiliate-1",
          programId: "program-1",
          minimumPayoutAmountOverride: new Prisma.Decimal("25"),
        }),
      },
      commission: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: { amount: new Prisma.Decimal("50") },
        }),
      },
    };

    const eligibility = await getPayoutEligibility(
      client as unknown as Parameters<typeof getPayoutEligibility>[0],
      GROUP,
      new Date("2026-11-10T12:00:00.000Z"),
    );

    expect(eligibility).toEqual({
      minimum: new Prisma.Decimal("25"),
      eligibleBalance: new Prisma.Decimal("50"),
      payable: true,
    });
  });

  it("keeps Program A's override for its commissions after reassignment to Program B", async () => {
    const client = {
      program: {
        findFirst: vi.fn().mockResolvedValue({
          id: "program-1",
          minimumPayoutAmount: new Prisma.Decimal("100"),
        }),
      },
      affiliate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "affiliate-1",
          programId: "program-2",
        }),
      },
      affiliateProgramTerms: {
        findUnique: vi.fn().mockResolvedValue({
          affiliateId: "affiliate-1",
          programId: "program-1",
          minimumPayoutAmountOverride: new Prisma.Decimal("25"),
        }),
      },
      commission: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: { amount: new Prisma.Decimal("50") },
        }),
      },
    };

    const eligibility = await getPayoutEligibility(
      client as unknown as Parameters<typeof getPayoutEligibility>[0],
      GROUP,
      new Date("2026-11-10T12:00:00.000Z"),
    );

    expect(eligibility).toEqual({
      minimum: new Prisma.Decimal("25"),
      eligibleBalance: new Prisma.Decimal("50"),
      payable: true,
    });
  });
});
