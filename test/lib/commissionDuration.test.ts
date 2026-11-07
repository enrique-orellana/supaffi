import { describe, expect, it } from "vitest";
import {
  commissionDurationLabel,
  parseCommissionDurationOverride,
} from "@/lib/commissionDuration";

describe("commission duration overrides", () => {
  it("parses the first-payment and forever choices without a month count", () => {
    expect(parseCommissionDurationOverride("ONE_TIME", "")).toEqual({ type: "ONE_TIME", months: null });
    expect(parseCommissionDurationOverride("FOREVER", "")).toEqual({ type: "FOREVER", months: null });
  });

  it("requires a positive whole number of months for a fixed term", () => {
    expect(parseCommissionDurationOverride("FIXED_MONTHS", "6")).toEqual({ type: "FIXED_MONTHS", months: 6 });
    expect(parseCommissionDurationOverride("FIXED_MONTHS", "0")).toBeNull();
    expect(parseCommissionDurationOverride("FIXED_MONTHS", "1.5")).toBeNull();
  });

  it("uses the same fixed-term wording for code overrides as the base setup", () => {
    expect(commissionDurationLabel("FIXED_MONTHS", 1)).toBe("of every payment, for 1 month");
    expect(commissionDurationLabel("FIXED_MONTHS", 6)).toBe("of every payment, for 6 months");
  });
});
