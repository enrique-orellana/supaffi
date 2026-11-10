import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateProgramInput } from "@/lib/programValidation";
import {
  MAX_COMMISSION_DURATION_MONTHS,
  MAX_COMMISSION_TERM_DAYS,
} from "@/lib/commissionTermLimits";

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

const VALID_PROGRAM = {
  name: "Standard",
  defaultCommissionRate: "20",
  commissionDurationType: "FOREVER",
  commissionDurationMonths: "",
  attributionWindowDays: "60",
  holdingPeriodDays: "30",
};

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

function affiliateSettings(values: Record<string, string>): FormData {
  const form = new FormData();
  form.set("programId", "program-1");
  form.set("commissionDurationTypeOverride", "inherit");
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe("adversarial commission term bounds", () => {
  beforeEach(() => {
    affiliateFindFirstMock.mockReset().mockResolvedValue({ id: "affiliate-1" });
    programFindFirstMock.mockReset().mockResolvedValue({
      id: "program-1",
      commissionDurationType: "FOREVER",
      commissionDurationMonths: null,
    });
    affiliateUpdateMock.mockReset().mockResolvedValue({});
    affiliateTermsUpsertMock.mockReset().mockResolvedValue({});
    affiliateTermsDeleteMock.mockReset().mockResolvedValue({ count: 0 });
    transactionMock
      .mockReset()
      .mockImplementation(async (callback) => callback(TX));
    recalculateAffiliateMock.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    [
      "fixed commission duration",
      {
        commissionDurationType: "FIXED_MONTHS",
        commissionDurationMonths: "121",
      },
    ],
    ["attribution window", { attributionWindowDays: "3651" }],
    ["holding period", { holdingPeriodDays: "3651" }],
  ])(
    "rejects a Program %s beyond the supported horizon",
    (_label, override) => {
      expect(
        validateProgramInput({ ...VALID_PROGRAM, ...override }),
      ).toMatchObject({ error: expect.any(String) });
    },
  );

  it("accepts Program terms exactly at the maximum supported horizon", () => {
    expect(
      validateProgramInput({
        ...VALID_PROGRAM,
        commissionDurationType: "FIXED_MONTHS",
        commissionDurationMonths: String(MAX_COMMISSION_DURATION_MONTHS),
        attributionWindowDays: String(MAX_COMMISSION_TERM_DAYS),
        holdingPeriodDays: String(MAX_COMMISSION_TERM_DAYS),
      }).error,
    ).toBeNull();
  });

  it.each([
    [
      "fixed commission duration",
      {
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: "121",
      },
    ],
    ["attribution window", { attributionWindowDaysOverride: "3651" }],
    ["holding period", { holdingPeriodDaysOverride: "3651" }],
  ])(
    "rejects an Affiliate %s beyond the supported horizon before writing",
    async (_label, override) => {
      const result = await saveAffiliateSettingsAction(
        PRODUCT,
        "affiliate-1",
        affiliateSettings(override),
      );

      expect(result).toMatchObject({ error: expect.any(String) });
      expect(transactionMock).not.toHaveBeenCalled();
      expect(affiliateUpdateMock).not.toHaveBeenCalled();
    },
  );

  it("accepts Affiliate overrides exactly at the maximum supported horizon", async () => {
    const result = await saveAffiliateSettingsAction(
      PRODUCT,
      "affiliate-1",
      affiliateSettings({
        commissionDurationTypeOverride: "FIXED_MONTHS",
        commissionDurationMonthsOverride: String(
          MAX_COMMISSION_DURATION_MONTHS,
        ),
        attributionWindowDaysOverride: String(MAX_COMMISSION_TERM_DAYS),
        holdingPeriodDaysOverride: String(MAX_COMMISSION_TERM_DAYS),
      }),
    );

    expect(result).toEqual({ success: true });
    expect(affiliateUpdateMock).toHaveBeenCalledWith({
      where: { id: "affiliate-1" },
      data: { programId: "program-1" },
    });
    expect(affiliateTermsUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          affiliateId_programId: {
            affiliateId: "affiliate-1",
            programId: "program-1",
          },
        },
        update: expect.objectContaining({
          commissionDurationMonthsOverride: MAX_COMMISSION_DURATION_MONTHS,
          attributionWindowDaysOverride: MAX_COMMISSION_TERM_DAYS,
          holdingPeriodDaysOverride: MAX_COMMISSION_TERM_DAYS,
        }),
      }),
    );
  });
});
