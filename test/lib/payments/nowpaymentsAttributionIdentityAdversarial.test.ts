import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nowpaymentsAdapter } from "@/lib/payments/providers/nowpayments";

const SECRET = "attribution-identity-adversarial-secret";

function sortForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForSignature);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortForSignature(child)]),
    );
  }
  return value;
}

function signedWebhook(payload: Record<string, unknown>): {
  rawBody: string;
  headers: Headers;
} {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha512", SECRET)
    .update(JSON.stringify(sortForSignature(payload)), "utf8")
    .digest("hex");
  return {
    rawBody,
    headers: new Headers({ "x-nowpayments-sig": signature }),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("NOWPayments attribution identity without webhook timestamps", () => {
  it("keeps invoice and payment identities distinct across signed timestamp-free events", () => {
    const seed = 0x1a771b;
    const random = seededRandom(seed);
    const statuses = ["waiting", "confirming", "finished", "refunded"];

    for (let index = 0; index < 64; index += 1) {
      const numericPaymentId = 700_000_000 + Math.floor(random() * 100_000);
      const paymentId =
        index % 2 === 0 ? numericPaymentId : `payment-${numericPaymentId}`;
      const numericInvoiceId = 5_100_000_000 + Math.floor(random() * 100_000);
      const invoiceId =
        index % 3 === 0 ? numericInvoiceId : `invoice-${numericInvoiceId}`;
      const status = statuses[Math.floor(random() * statuses.length)];
      const payload: Record<string, unknown> = {
        payment_id: paymentId,
        invoice_id: invoiceId,
        payment_status: status,
        price_amount: "2",
        price_currency: "EUR",
        order_id: `merchant-order-${index}`,
        // Deliberately omit created_at and updated_at: neither is part of
        // the referral key or payment identity.
      };
      const signed = signedWebhook(payload);
      const event = nowpaymentsAdapter.verifyAndParseWebhook({
        ...signed,
        connection: { webhookSecret: SECRET },
      });
      const label = `seed=${seed}, case=${index}`;

      expect(event, label).not.toBeNull();
      expect(event?.paymentRef, label).toBe(String(paymentId));
      expect(event?.checkoutRef, label).toBe(String(invoiceId));
      expect(event?.eventId, label).toBe(`${paymentId}:${status}`);
      expect(Number.isNaN(event?.occurredAt.getTime()), label).toBe(false);
      const rawPayload = event?.rawPayload as Record<string, unknown>;
      expect(rawPayload.created_at, label).toBeUndefined();
      expect(rawPayload.updated_at, label).toBeUndefined();
    }
  });

  it("requires a payment ID but keeps a payment unmatched when its invoice ID is absent or malformed", () => {
    const paymentId = "5634396091";
    const paymentWithoutInvoice = signedWebhook({
      payment_id: paymentId,
      invoice_id: null,
      payment_status: "finished",
      price_amount: "2",
      price_currency: "EUR",
    });
    const noInvoiceEvent = nowpaymentsAdapter.verifyAndParseWebhook({
      ...paymentWithoutInvoice,
      connection: { webhookSecret: SECRET },
    });
    expect(noInvoiceEvent?.paymentRef).toBe(paymentId);
    expect(noInvoiceEvent?.checkoutRef).toBeNull();

    const malformedInvoice = signedWebhook({
      payment_id: paymentId,
      invoice_id: { attackerControlled: "not-an-invoice-id" },
      payment_status: "finished",
      price_amount: "2",
      price_currency: "EUR",
    });
    const malformedInvoiceEvent = nowpaymentsAdapter.verifyAndParseWebhook({
      ...malformedInvoice,
      connection: { webhookSecret: SECRET },
    });
    expect(malformedInvoiceEvent?.paymentRef).toBe(paymentId);
    expect(malformedInvoiceEvent?.checkoutRef).toBeNull();

    const noPaymentId = signedWebhook({
      invoice_id: "invoice-5100474464",
      payment_status: "finished",
      price_amount: "2",
      price_currency: "EUR",
    });
    expect(
      nowpaymentsAdapter.verifyAndParseWebhook({
        ...noPaymentId,
        connection: { webhookSecret: SECRET },
      }),
    ).toBeNull();
  });

  it("does not need valid timestamp fields to accept an authenticated payment", () => {
    const payload = {
      payment_id: "5634396091",
      invoice_id: "5100474464",
      payment_status: "finished",
      price_amount: "2",
      price_currency: "EUR",
      created_at: "not-a-date",
      updated_at: null,
    };
    const event = nowpaymentsAdapter.verifyAndParseWebhook({
      ...signedWebhook(payload),
      connection: { webhookSecret: SECRET },
    });

    expect(event?.paymentRef).toBe("5634396091");
    expect(event?.checkoutRef).toBe("5100474464");
    expect(Number.isNaN(event?.occurredAt.getTime())).toBe(false);
  });
});
