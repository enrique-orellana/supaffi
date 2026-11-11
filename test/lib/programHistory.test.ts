import { describe, expect, it } from "vitest";
import {
  programHistoryChanges,
  type ProgramHistorySnapshot,
} from "@/lib/programHistory";

function snapshot(
  overrides: Partial<ProgramHistorySnapshot> = {},
): ProgramHistorySnapshot {
  return {
    name: "Arthouse Partners",
    defaultCommissionRate: "20.00",
    commissionDurationType: "FOREVER",
    commissionDurationMonths: null,
    attributionWindowDays: 60,
    holdingPeriodDays: 30,
    currency: "eur",
    minimumPayoutAmount: "0.00",
    signupOpen: true,
    ...overrides,
  };
}

describe("programHistoryChanges", () => {
  it("shows the saved before and after commission rates", () => {
    expect(
      programHistoryChanges(
        snapshot({ defaultCommissionRate: "20.00" }),
        snapshot({ defaultCommissionRate: "16.00" }),
      ),
    ).toEqual([
      {
        key: "defaultCommissionRate",
        label: "Commission rate",
        before: "20%",
        after: "16%",
      },
    ]);
  });

  it("combines duration settings and keeps payout minimums independent of display currency", () => {
    expect(
      programHistoryChanges(
        snapshot({
          commissionDurationType: "FOREVER",
          commissionDurationMonths: null,
          currency: "eur",
          minimumPayoutAmount: "100.00",
        }),
        snapshot({
          commissionDurationType: "FIXED_MONTHS",
          commissionDurationMonths: 12,
          currency: "gbp",
          minimumPayoutAmount: "200.00",
        }),
      ),
    ).toEqual([
      {
        key: "commissionDuration",
        label: "Commission duration",
        before: "Forever",
        after: "12 months",
      },
      {
        key: "currency",
        label: "Dashboard currency",
        before: "EUR",
        after: "GBP",
      },
      {
        key: "minimumPayoutAmount",
        label: "Minimum payout",
        before: "100.00 in each transaction currency",
        after: "200.00 in each transaction currency",
      },
    ]);
  });

  it("returns no rows when a save did not change any program settings", () => {
    const unchanged = snapshot();
    expect(programHistoryChanges(unchanged, unchanged)).toEqual([]);
  });
});
