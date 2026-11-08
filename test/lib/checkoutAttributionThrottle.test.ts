import { afterEach, describe, expect, it } from "vitest";
import {
  isCheckoutAttributionLimited,
  rememberCheckoutAttribution,
  resetCheckoutAttributionThrottle,
} from "@/lib/checkoutAttributionThrottle";

describe("checkout attribution tracking limit", () => {
  afterEach(resetCheckoutAttributionThrottle);

  it("limits bursts per public address and merchant without sharing limits between merchants", () => {
    for (let i = 0; i < 120; i += 1)
      rememberCheckoutAttribution("merchant-a", "203.0.113.5", 1_000);

    expect(
      isCheckoutAttributionLimited("merchant-a", "203.0.113.5", 1_001),
    ).toBe(true);
    expect(
      isCheckoutAttributionLimited("merchant-b", "203.0.113.5", 1_001),
    ).toBe(false);
    expect(
      isCheckoutAttributionLimited("merchant-a", "203.0.113.5", 601_001),
    ).toBe(false);
  });
});
