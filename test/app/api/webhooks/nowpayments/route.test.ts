import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findConnection, createEvent } = vi.hoisted(() => ({
  findConnection: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    paymentConnection: { findFirst: findConnection },
    webhookEvent: { create: createEvent },
  },
}));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => value }));

const { POST } =
  await import("@/app/api/webhooks/nowpayments/[connectionId]/route");

const MERCHANT_ID = "merchant-a";
const CONNECTION_ID = "connection-route-123";
const NOWPAYMENTS_SECRET = "merchant-nowpayments-ipn-secret";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function providerBody(): string {
  return '{ "payment_status" : "finished", "payment_id": 9182, "invoice_id": null, "order_id":"local-order-12", "price_amount":19.95, "price_currency":"USD", "actually_paid":0.00031, "pay_currency":"BTC" }';
}

function directRequest(
  body: string,
  secret = NOWPAYMENTS_SECRET,
  contentType = "application/json",
): Request {
  const signature = createHmac("sha512", secret)
    .update(JSON.stringify(sorted(JSON.parse(body))), "utf8")
    .digest("hex");
  return new Request(
    `https://supaffi.example/api/webhooks/nowpayments/${CONNECTION_ID}`,
    {
      method: "POST",
      headers: { "content-type": contentType, "x-nowpayments-sig": signature },
      body,
    },
  );
}

const context = { params: Promise.resolve({ connectionId: CONNECTION_ID }) };

describe("POST /api/webhooks/nowpayments", () => {
  beforeEach(() => {
    findConnection.mockReset().mockResolvedValue({
      id: "payment-connection",
      merchantId: MERCHANT_ID,
      webhookSecretEnc: NOWPAYMENTS_SECRET,
    });
    createEvent.mockReset().mockResolvedValue({});
  });

  it("accepts the provider-signed IPN and queues its normalized payment facts", async () => {
    const body = providerBody();
    const response = await POST(directRequest(body), context);

    expect(response.status).toBe(200);
    expect(findConnection).toHaveBeenCalledWith({
      where: {
        webhookRouteId: CONNECTION_ID,
        provider: "NOWPAYMENTS",
        enabled: true,
        status: "CONNECTED",
      },
      select: { id: true, merchantId: true, webhookSecretEnc: true },
    });
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        merchantId: MERCHANT_ID,
        provider: "NOWPAYMENTS",
        providerEventId: "9182:finished",
        payload: expect.objectContaining({
          eventId: "9182:finished",
          checkoutRef: null,
          rawPayload: {
            payment_status: "finished",
            payment_id: "9182",
            invoice_id: null,
            order_id: "local-order-12",
            price_amount: "19.95",
            price_currency: "USD",
            actually_paid: "0.00031",
            pay_currency: "BTC",
          },
        }),
      }),
    });
    expect(
      createEvent.mock.calls[0][0].data.payload.referralToken,
    ).toBeUndefined();
  });

  it("rejects a provider signature that does not match the saved IPN secret", async () => {
    const response = await POST(
      directRequest(providerBody(), "wrong-secret"),
      context,
    );

    expect(response.status).toBe(400);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("does not require a Supaffi-to-merchant integration signature", async () => {
    const response = await POST(directRequest(providerBody()), context);

    expect(response.status).toBe(200);
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON requests and accepts provider events without optional order or invoice IDs", async () => {
    const contentType = await POST(
      directRequest(providerBody(), NOWPAYMENTS_SECRET, "text/plain"),
      context,
    );
    const noOptionalReferences = JSON.stringify({
      payment_status: "finished",
      payment_id: 9182,
      invoice_id: null,
      order_id: null,
      price_amount: 19.95,
      price_currency: "USD",
    });
    const validEvent = await POST(directRequest(noOptionalReferences), context);

    expect(contentType.status).toBe(415);
    expect(validEvent.status).toBe(200);
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("acknowledges provider redeliveries without queueing a duplicate", async () => {
    createEvent.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const response = await POST(directRequest(providerBody()), context);

    expect(response.status).toBe(200);
    expect(createEvent).toHaveBeenCalledTimes(1);
  });
});
