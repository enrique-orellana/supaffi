import { beforeEach, describe, expect, it, vi } from "vitest";

import { getIntegrationStatus } from "@/lib/merchant";
import { getNowPaymentsConnectionStatus } from "@/lib/paymentConnections";
import {
  getPaymentProviderSetup,
  listPaymentProviderSetups,
  listPaymentTrackingGuides,
} from "@/lib/payments/setupRegistry";
import { PaymentProvider } from "@/lib/payments/types";
import type { PaymentProviderSetupStatus } from "@/lib/payments/setupRegistry";

const credentialsAreNotSetupDetails: PaymentProviderSetupStatus["details"] = {
  // @ts-expect-error Plaintext credentials are not display-safe setup metadata.
  apiKey: "test-secret",
};
const ciphertextIsNotSetupDetails: PaymentProviderSetupStatus["details"] = {
  // @ts-expect-error Credential ciphertext is not display-safe setup metadata.
  apiKeyEnc: "test-ciphertext",
};
void credentialsAreNotSetupDetails;
void ciphertextIsNotSetupDetails;

vi.mock("@/lib/merchant", () => ({
  getIntegrationStatus: vi.fn(),
}));

vi.mock("@/lib/paymentConnections", () => ({
  getNowPaymentsConnectionStatus: vi.fn(),
}));

describe("payment provider setup registry", () => {
  beforeEach(() => {
    vi.mocked(getIntegrationStatus).mockResolvedValue({
      stripe: true,
      stripeKey: true,
      stripeWebhook: true,
    });
    vi.mocked(getNowPaymentsConnectionStatus).mockResolvedValue({
      connected: true,
      hasCallbackId: true,
      callbackUrl: "https://supaffi.example/api/webhooks/nowpayments/route-id",
    });
  });

  it("lists Stripe and NOWPayments once with their central identities", () => {
    const setups = listPaymentProviderSetups();

    expect(setups.map(({ provider, label }) => [provider, label])).toEqual([
      [PaymentProvider.STRIPE.id, PaymentProvider.STRIPE.label],
      [PaymentProvider.NOWPAYMENTS.id, PaymentProvider.NOWPAYMENTS.label],
    ]);
    expect(new Set(setups.map(({ provider }) => provider)).size).toBe(2);
  });

  it("pairs each provider with its reusable connection panel", () => {
    expect(listPaymentProviderSetups().map(({ panel }) => panel.name)).toEqual([
      "StripeConnectionPanel",
      "NowPaymentsConnectionPanel",
    ]);
  });

  it("shows the supported automatic checkout-capture path for connected NOWPayments", () => {
    const guides = listPaymentTrackingGuides([PaymentProvider.NOWPAYMENTS.id]);

    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      provider: PaymentProvider.NOWPAYMENTS.id,
      label: PaymentProvider.NOWPAYMENTS.label,
      title: "NOWPayments hosted invoices",
    });
    expect(guides[0].checkoutSnippet).toBeUndefined();
    expect(guides[0].description).toContain("same-origin fetch POSTs");
    expect(guides[0].description).toContain("cross-origin fetch POSTs");
    expect(guides[0].description).toContain("CORS");
    expect(guides[0].description).toContain("XHR");
    expect(listPaymentTrackingGuides([])).toEqual([]);
  });

  it("keeps Stripe's server-side referral instructions in its provider module", () => {
    const stripe = listPaymentTrackingGuides([PaymentProvider.STRIPE.id])[0];

    expect(stripe.checkoutSnippet).toContain("supaffi_referral");
    expect(stripe.checkoutPrompt).toContain("Stripe Checkout");
  });

  it("maps Stripe connection diagnostics to safe status metadata", async () => {
    const setup = getPaymentProviderSetup(PaymentProvider.STRIPE.id);

    expect(setup?.checkSections).toEqual([PaymentProvider.STRIPE.id]);
    await expect(setup?.readStatus("owner-1", "merchant-1")).resolves.toEqual({
      connected: true,
      details: { keyStored: true, webhookStored: true },
    });
    expect(getIntegrationStatus).toHaveBeenCalledWith("owner-1", "merchant-1");
  });

  it("exposes only the NOWPayments callback URL as status metadata", async () => {
    const setup = getPaymentProviderSetup(PaymentProvider.NOWPAYMENTS.id);

    expect(setup?.checkSections).toEqual([]);
    await expect(setup?.readStatus("owner-2", "merchant-2")).resolves.toEqual({
      connected: true,
      details: {
        callbackUrl:
          "https://supaffi.example/api/webhooks/nowpayments/route-id",
      },
    });
    expect(getNowPaymentsConnectionStatus).toHaveBeenCalledWith(
      "owner-2",
      "merchant-2",
    );
  });
});
