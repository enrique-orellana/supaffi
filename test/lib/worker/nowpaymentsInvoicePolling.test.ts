import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPaymentsPayment } from "@/lib/payments/providers/nowpaymentsApi";

const {
  db,
  rawQuery,
  updateAttribution,
  findAttributions,
  createEvents,
  listPayments,
} = vi.hoisted(() => {
  const rawQuery = vi.fn();
  const updateAttribution = vi.fn();
  const findAttributions = vi.fn();
  const createEvents = vi.fn();
  const listPayments = vi.fn();
  const tx = {
    $queryRaw: rawQuery,
    checkoutAttribution: { updateMany: updateAttribution },
  };
  const transaction = vi.fn(async (callback) => callback(tx));
  return {
    db: {
      $transaction: transaction,
      checkoutAttribution: {
        findMany: findAttributions,
        updateMany: updateAttribution,
      },
      webhookEvent: { createMany: createEvents },
    },
    rawQuery,
    updateAttribution,
    findAttributions,
    createEvents,
    listPayments,
  };
});

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => value }));
vi.mock("@/lib/payments/providers/nowpaymentsApi", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/payments/providers/nowpaymentsApi")
    >();
  return { ...actual, listNowPaymentsPaymentsByInvoice: listPayments };
});

const { listNowPaymentsPaymentsByInvoice } =
  await import("@/lib/payments/providers/nowpaymentsApi");
const { runNowPaymentsInvoicePoller } =
  await import("@/lib/worker/nowpaymentsInvoicePolling");

const future = new Date(Date.now() + 7 * 24 * 60 * 60_000);
const connection = {
  enabled: true,
  status: "CONNECTED",
  apiKeyEnc: "api-key",
  apiAccountEmailEnc: "view@example.test",
  apiAccountPasswordEnc: "view-password",
};

function payment(
  paymentStatus: NowPaymentsPayment["payment_status"],
): NowPaymentsPayment {
  return {
    payment_id: "payment-1",
    payment_status: paymentStatus,
    invoice_id: "invoice-1",
    order_id: "order-1",
    price_amount: "29.99",
    price_currency: "eur",
    pay_amount: "0.0004",
    pay_currency: "btc",
    actually_paid: "0.0004",
    network: "bitcoin",
    updated_at: "2026-11-08T11:59:00.000Z",
  };
}

describe("NOWPayments invoice polling worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rawQuery.mockResolvedValue([{ id: "attribution-1" }]);
    updateAttribution.mockResolvedValue({ count: 1 });
    findAttributions.mockResolvedValue([
      {
        id: "attribution-1",
        merchantId: "merchant-1",
        providerCheckoutRef: "invoice-1",
        clickId: "click-1",
        pollAttempts: 1,
        pollFailures: 0,
        click: { expiresAt: future },
        merchant: { paymentConnections: [connection] },
      },
    ]);
    createEvents.mockResolvedValue({ count: 1 });
    vi.mocked(listNowPaymentsPaymentsByInvoice).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a slower check when NOWPayments has not created a payment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));

    await runNowPaymentsInvoicePoller();

    expect(listNowPaymentsPaymentsByInvoice).toHaveBeenCalledWith("invoice-1", {
      apiKey: "api-key",
      email: "view@example.test",
      password: "view-password",
    });
    expect(updateAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pollNextAt: new Date("2026-11-08T12:05:00.000Z"),
          pollFailures: 0,
          pollLastError: null,
        }),
      }),
    );
    expect(createEvents).not.toHaveBeenCalled();
  });

  it("queues verified-provider candidates once and closes on a finished payment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    vi.mocked(listNowPaymentsPaymentsByInvoice).mockResolvedValue([
      payment("finished"),
    ]);

    await runNowPaymentsInvoicePoller();

    expect(createEvents).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          merchantId: "merchant-1",
          provider: "NOWPAYMENTS",
          providerEventId: "payment-1:finished",
          payload: expect.objectContaining({
            provider: "nowpayments",
            eventId: "payment-1:finished",
            paymentRef: "payment-1",
            checkoutRef: "invoice-1",
            rawPayload: expect.objectContaining({
              payment_id: "payment-1",
              payment_status: "finished",
              invoice_id: "invoice-1",
            }),
          }),
        }),
      ],
      skipDuplicates: true,
    });
    expect(updateAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pollNextAt: null,
          pollClosedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("closes an expired payment attempt without creating a commission event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    vi.mocked(listNowPaymentsPaymentsByInvoice).mockResolvedValue([
      payment("expired"),
    ]);

    await runNowPaymentsInvoicePoller();

    expect(createEvents).toHaveBeenCalledOnce();
    expect(createEvents.mock.calls[0][0].data[0].payload.kind).toBe(
      "payment_failed",
    );
    expect(updateAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pollNextAt: null,
          pollClosedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("stops before calling NOWPayments when the buy window has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    findAttributions.mockResolvedValueOnce([
      {
        id: "attribution-1",
        merchantId: "merchant-1",
        providerCheckoutRef: "invoice-1",
        clickId: "click-1",
        pollAttempts: 1,
        pollFailures: 0,
        click: { expiresAt: new Date("2026-11-08T11:59:59.000Z") },
        merchant: { paymentConnections: [connection] },
      },
    ]);

    await runNowPaymentsInvoicePoller();

    expect(listNowPaymentsPaymentsByInvoice).not.toHaveBeenCalled();
    expect(updateAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pollNextAt: null,
          pollClosedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("backs off API failures without exposing credential material", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    vi.mocked(listNowPaymentsPaymentsByInvoice).mockRejectedValue(
      new Error("NOWPayments API request failed (503)"),
    );

    await runNowPaymentsInvoicePoller();

    const update = updateAttribution.mock.calls.at(-1)?.[0];
    expect(update.data.pollNextAt).toEqual(
      new Date("2026-11-08T12:01:00.000Z"),
    );
    expect(update.data.pollFailures).toEqual({ increment: 1 });
    expect(update.data.pollLastError).toBe(
      "NOWPayments API request failed (503)",
    );
    expect(JSON.stringify(update)).not.toContain("view-password");
  });

  it("pauses due invoices when the read-only lookup account is not configured", async () => {
    findAttributions.mockResolvedValueOnce([
      {
        id: "attribution-1",
        merchantId: "merchant-1",
        providerCheckoutRef: "invoice-1",
        clickId: "click-1",
        pollAttempts: 1,
        pollFailures: 0,
        click: { expiresAt: future },
        merchant: {
          paymentConnections: [{ ...connection, apiAccountPasswordEnc: null }],
        },
      },
    ]);

    await runNowPaymentsInvoicePoller();

    expect(listNowPaymentsPaymentsByInvoice).not.toHaveBeenCalled();
    expect(updateAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { pollNextAt: null } }),
    );
  });
});
