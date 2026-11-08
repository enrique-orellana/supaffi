import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNowPaymentsPayment,
  testNowPaymentsApiKeyAccess,
} from "@/lib/payments/providers/nowpaymentsApi";

describe("NOWPayments payment status API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up a payment by ID using the merchant API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_id: "5392802625",
          payment_status: "finished",
          price_amount: 29.99,
          price_currency: "EUR",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getNowPaymentsPayment("5392802625", "merchant-api-key"),
    ).resolves.toMatchObject({
      payment_id: "5392802625",
      payment_status: "finished",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.nowpayments.io/v1/payment/5392802625",
      expect.objectContaining({
        method: "GET",
        headers: { "x-api-key": "merchant-api-key" },
        cache: "no-store",
      }),
    );
  });

  it("rejects an API response for a different payment ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            payment_id: "other-payment",
            payment_status: "finished",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      getNowPaymentsPayment("5392802625", "merchant-api-key"),
    ).rejects.toThrow("payment ID did not match");
  });

  it("rejects provider errors without exposing the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("private provider error details", { status: 401 }),
        ),
    );

    await expect(
      getNowPaymentsPayment("5392802625", "merchant-api-key"),
    ).rejects.toThrow("NOWPayments API request failed (401)");
  });

  it("validates an API key using an endpoint that requires no account login", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ currencies: ["btc", "eth"] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testNowPaymentsApiKeyAccess("merchant-api-key"),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.nowpayments.io/v1/currencies",
      expect.objectContaining({
        method: "GET",
        headers: { "x-api-key": "merchant-api-key" },
      }),
    );
  });
});
