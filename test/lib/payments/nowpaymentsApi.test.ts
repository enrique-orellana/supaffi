import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNowPaymentsPayment,
  listNowPaymentsPaymentsByInvoice,
  testNowPaymentsPaymentListAccess,
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

  it("authenticates and lists payments for a specific invoice", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "short-lived-jwt" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                payment_id: 5392802625,
                payment_status: "waiting",
                invoice_id: 4522625843,
                price_amount: 29.99,
                price_currency: "EUR",
                actually_paid: 0,
                pay_currency: "btc",
                updated_at: "2026-11-08T10:00:00.000Z",
              },
            ],
            total: 1,
            pagesCount: 1,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listNowPaymentsPaymentsByInvoice("4522625843", {
        apiKey: "merchant-api-key",
        email: "list-request@example.test",
        password: "view-only-password",
      }),
    ).resolves.toMatchObject([
      {
        payment_id: "5392802625",
        payment_status: "waiting",
        invoice_id: "4522625843",
        price_amount: "29.99",
        price_currency: "eur",
      },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.nowpayments.io/v1/auth",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "list-request@example.test",
          password: "view-only-password",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.nowpayments.io/v1/payment/?invoiceid=4522625843&limit=500&page=0",
      expect.objectContaining({
        method: "GET",
        headers: {
          "x-api-key": "merchant-api-key",
          Authorization: "Bearer short-lived-jwt",
        },
      }),
    );
  });

  it("rejects a payment list containing a different invoice ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ token: "another-jwt" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [
                {
                  payment_id: 99,
                  payment_status: "finished",
                  invoice_id: 101,
                  price_amount: 10,
                  price_currency: "USD",
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      listNowPaymentsPaymentsByInvoice("100", {
        apiKey: "merchant-api-key",
        email: "other-read-only@example.test",
        password: "view-only-password",
      }),
    ).rejects.toThrow("payment list included a different invoice ID");
  });

  it("tests account read access without retaining or returning payment details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "list-access-jwt" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagesCount: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testNowPaymentsPaymentListAccess({
        apiKey: "merchant-api-key",
        email: "access-check@example.test",
        password: "view-only-password",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.nowpayments.io/v1/payment/?limit=1&page=0",
      expect.objectContaining({
        headers: {
          "x-api-key": "merchant-api-key",
          Authorization: "Bearer list-access-jwt",
        },
      }),
    );
  });
});
