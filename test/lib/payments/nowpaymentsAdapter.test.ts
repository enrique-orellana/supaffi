import { describe, expect, it } from "vitest";
import { nowpaymentsAdapter } from "@/lib/payments/providers/nowpayments";

describe("NOWPayments adapter checkout capability", () => {
  it("tracks invoice references without creating invoices", () => {
    expect(nowpaymentsAdapter.capabilities.hostedCheckout).toBe(false);
    expect(nowpaymentsAdapter.clientTracking).toMatchObject({
      allowedHosts: ["nowpayments.io", "sandbox.nowpayments.io"],
      path: "/payment/",
      referenceQueryParameter: "iid",
    });
  });
});
