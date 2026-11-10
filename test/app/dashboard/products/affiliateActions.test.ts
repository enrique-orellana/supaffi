import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  affiliateFindFirstMock,
  programFindFirstMock,
  affiliateUpdateMock,
  affiliateTermsUpsertMock,
  affiliateTermsDeleteMock,
  transactionMock,
  recalculateAffiliateMock,
} = vi.hoisted(() => ({
  affiliateFindFirstMock: vi.fn(),
  programFindFirstMock: vi.fn(),
  affiliateUpdateMock: vi.fn(),
  affiliateTermsUpsertMock: vi.fn(),
  affiliateTermsDeleteMock: vi.fn(),
  transactionMock: vi.fn(),
  recalculateAffiliateMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "owner-1", role: "owner" } }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));
vi.mock("@/lib/affiliatePassword", () => ({
  createAffiliateResetLink: vi.fn(),
}));
vi.mock("@/lib/payoutEligibility", () => ({
  recalculateAffiliatePayoutEligibility: (...args: unknown[]) =>
    recalculateAffiliateMock(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import { saveAffiliateSettingsAction } from "@/app/dashboard/products/[product]/affiliates/affiliateActions";

const PRODUCT = { id: "merchant-1", slug: "acme" };
const TX = {
  affiliate: {
    findFirst: affiliateFindFirstMock,
    update: affiliateUpdateMock,
  },
  affiliateProgramTerms: {
    upsert: affiliateTermsUpsertMock,
    deleteMany: affiliateTermsDeleteMock,
  },
  program: { findFirst: programFindFirstMock },
};

function settings(values: Record<string, string>): FormData {
  const form = new FormData();
  form.set("programId", "program-1");
  form.set("commissionDurationTypeOverride", "inherit");
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe("saveAffiliateSettingsAction", () => {
  beforeEach(() => {
    affiliateFindFirstMock.mockReset().mockResolvedValue({ id: "affiliate-1" });
    programFindFirstMock.mockReset().mockResolvedValue({ id: "program-1" });
    affiliateUpdateMock.mockReset().mockResolvedValue({});
    affiliateTermsUpsertMock.mockReset().mockResolvedValue({});
    affiliateTermsDeleteMock.mockReset().mockResolvedValue({ count: 0 });
    transactionMock
      .mockReset()
      .mockImplementation(async (callback) => callback(TX));
    recalculateAffiliateMock.mockReset().mockResolvedValue(undefined);
  });

  it("saves affiliate-level rate and minimum overrides and recalculates payability", async () => {
    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      settings({
        commissionRateOverride: "27.5",
        minimumPayoutAmountOverride: "75",
      }),
    );

    expect(result).toEqual({ success: true });
    expect(affiliateUpdateMock).toHaveBeenCalledWith({
      where: { id: "affiliate-1" },
      data: { programId: "program-1" },
    });
    expect(affiliateTermsUpsertMock).toHaveBeenCalledWith({
      where: {
        affiliateId_programId: {
          affiliateId: "affiliate-1",
          programId: "program-1",
        },
      },
      create: expect.objectContaining({
        merchantId: PRODUCT.id,
        affiliateId: "affiliate-1",
        programId: "program-1",
        customCommissionRate: "27.50",
        minimumPayoutAmountOverride: "75.00",
      }),
      update: expect.objectContaining({
        customCommissionRate: "27.50",
        minimumPayoutAmountOverride: "75.00",
      }),
    });
    expect(recalculateAffiliateMock).toHaveBeenCalledWith(
      TX,
      PRODUCT.id,
      "affiliate-1",
    );
  });

  it("clears blank rate and minimum fields so they inherit Program terms", async () => {
    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      settings({
        commissionRateOverride: "",
        minimumPayoutAmountOverride: "",
      }),
    );

    expect(result).toEqual({ success: true });
    expect(affiliateUpdateMock).toHaveBeenCalledWith({
      where: { id: "affiliate-1" },
      data: { programId: "program-1" },
    });
    expect(affiliateTermsDeleteMock).toHaveBeenCalledWith({
      where: {
        merchantId: PRODUCT.id,
        affiliateId: "affiliate-1",
        programId: "program-1",
      },
    });
  });

  it("writes overrides to the selected Affiliate/Program pair", async () => {
    programFindFirstMock.mockResolvedValue({ id: "program-2" });

    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      settings({
        programId: "program-2",
        commissionRateOverride: "35",
      }),
    );

    expect(result).toEqual({ success: true });
    expect(affiliateTermsUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          affiliateId_programId: {
            affiliateId: "affiliate-1",
            programId: "program-2",
          },
        },
        create: expect.objectContaining({
          affiliateId: "affiliate-1",
          programId: "program-2",
          customCommissionRate: "35.00",
        }),
      }),
    );
    expect(affiliateTermsDeleteMock).not.toHaveBeenCalled();
  });

  it("rejects rates outside the supported percentage range", async () => {
    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      settings({ commissionRateOverride: "100.01" }),
    );

    expect(result).toEqual({
      error: "Commission rate must be greater than 0 and no more than 100.",
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("requires months when the Program has no fixed-month count to inherit", async () => {
    programFindFirstMock.mockResolvedValue({
      id: "program-1",
      commissionDurationType: "FOREVER",
      commissionDurationMonths: null,
    });

    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      settings({ commissionDurationTypeOverride: "FIXED_MONTHS" }),
    );

    expect(result).toEqual({
      error: "Enter a whole number of months, at least 1.",
    });
    expect(affiliateUpdateMock).not.toHaveBeenCalled();
  });
});
