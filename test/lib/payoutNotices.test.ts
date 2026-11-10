import { describe, it, expect } from "vitest";
import { PAYOUT_ERROR, STALE_PAGE } from "@/lib/commission";
import { refusalText } from "@/lib/payoutNotices";

describe("refusalText", () => {
  it("turns known payout errors into safe, user-facing messages", () => {
    expect(refusalText(PAYOUT_ERROR.EMPTY)).toBe(
      "Nothing was selected, so there was nothing to pay.",
    );
    expect(refusalText(PAYOUT_ERROR.STALE_PAGE)).toBe(STALE_PAGE);
  });

  it("does not show unknown error codes", () => {
    expect(refusalText(undefined)).toBeNull();
    expect(refusalText("unexpected-input")).toBeNull();
  });
});
