import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Merchant, WebhookEvent } from "@prisma/client";
import { PaymentProvider, type VerifiedProviderEvent } from "@/lib/payments/types";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { POST as registerCheckoutRoute } from "@/app/api/track/checkout-attribution/route";
import { POST as receiveNowPaymentsIpn } from "@/app/api/webhooks/nowpayments/[connectionId]/route";
import { runTick } from "@/lib/worker/tick";
import { createLocalRelayServer } from "../../../integrations/nowpayments-webhook-relay/local-dev-relay.mjs";
import {
  handleNowPaymentsEvent,
  reconcileNowPaymentsCheckoutAttribution,
} from "@/lib/worker/handlers/nowpayments";

const REFERRAL_TOKEN = "90c50a4d-2460-42c8-95cb-b2e3d9e9f2b5";
const INVOICE_REFERENCE = "invoice-21";
const MOCK_INVOICE_REFERENCE = "90020";
const NOWPAYMENTS_SECRET = "local-mock-ipn-secret";
const TEST_ENCRYPTION_KEY = "a".repeat(64);

type TestQueuedEvent = VerifiedProviderEvent & { rawPayload: Record<string, unknown> };

function sortForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForSignature);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortForSignature(item)])
    );
  }
  return value;
}

function queuedEvent(paymentStatus: "finished" | "waiting" | "refunded", paymentRef = "payment-21"): TestQueuedEvent {
  const updatedAt = new Date();
  return {
    provider: PaymentProvider.NOWPAYMENTS.id,
    eventId: `${paymentRef}:${paymentStatus}`,
    kind: paymentStatus === "finished" ? "payment_succeeded" : paymentStatus === "refunded" ? "payment_refunded" : "payment_pending",
    paymentRef,
    checkoutRef: INVOICE_REFERENCE,
    saleAmount: "31.25",
    saleCurrency: "eur",
    cryptoAmount: "0.00123456",
    cryptoCurrency: "btc",
    occurredAt: updatedAt,
    rawPayload: {
      payment_status: paymentStatus,
      payment_id: paymentRef,
      invoice_id: INVOICE_REFERENCE,
      order_id: "local-order-21",
      price_amount: "31.25",
      price_currency: "EUR",
      actually_paid: "0.00123456",
      pay_currency: "BTC",
      network: "btc",
      updated_at: updatedAt.toISOString(),
    },
  };
}

async function clearAll() {
  await db.commerceEventDelivery.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.commission.deleteMany({ where: { adjustsCommissionId: { not: null } } });
  await db.commission.deleteMany();
  await db.paymentRecord.deleteMany();
  await db.commerceCheckout.deleteMany();
  await db.checkoutAttribution.deleteMany();
  await db.referredSubscription.deleteMany();
  await db.click.deleteMany();
  await db.affiliateLink.deleteMany();
  await db.affiliate.deleteMany();
  await db.program.deleteMany();
  await db.paymentConnection.deleteMany();
  await db.merchant.deleteMany();
  await db.owner.deleteMany();
}

describe("NOWPayments checkout attribution", () => {
  let merchant: Merchant;
  let clickId: string;

  beforeEach(async () => {
    await clearAll();
    const owner = await db.owner.create({
      data: { email: `owner-${crypto.randomUUID()}@example.com`, passwordHash: "x" },
    });
    merchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId: owner.id,
        name: "Product",
        domain: `${crypto.randomUUID()}.example.com`,
        websiteUrl: "https://product.example.com",
        paymentConnections: {
          create: {
            provider: PaymentProvider.NOWPAYMENTS.database,
            apiKeyEnc: null,
            webhookSecretEnc: "encrypted-ipn-secret",
            status: "CONNECTED",
            enabled: true,
          },
        },
      },
    });
    const program = await db.program.create({
      data: {
        slug: crypto.randomUUID(),
        merchantId: merchant.id,
        name: "Standard",
        defaultCommissionRate: 20,
        commissionDurationType: "FOREVER",
        attributionWindowDays: 60,
        holdingPeriodDays: 30,
      },
    });
    const affiliate = await db.affiliate.create({
      data: {
        merchantId: merchant.id,
        programId: program.id,
        email: `affiliate-${crypto.randomUUID()}@example.com`,
        links: { create: { code: crypto.randomUUID(), isPrimary: true } },
      },
    });
    const click = await db.click.create({
      data: {
        merchantId: merchant.id,
        affiliateId: affiliate.id,
        referralToken: REFERRAL_TOKEN,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    });
    clickId = click.id;
  });

  afterAll(async () => {
    await clearAll();
    await db.$disconnect();
  });

  async function registerCheckout(reference = INVOICE_REFERENCE, createdAt?: Date) {
    await db.checkoutAttribution.create({
      data: {
        merchantId: merchant.id,
        provider: PaymentProvider.NOWPAYMENTS.database,
        providerCheckoutRef: reference,
        clickId,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  async function processEvent(
    event = queuedEvent("finished"),
    providerEventId = event.eventId,
    createdAt = new Date()
  ) {
    await handleNowPaymentsEvent({
      merchantId: merchant.id,
      providerEventId,
      // WebhookEvent.payload is PostgreSQL JSON, so Dates have already been
      // serialized to ISO strings by the time the worker reads this row.
      payload: JSON.parse(JSON.stringify(event)),
      createdAt,
    } as unknown as WebhookEvent);
  }

  async function persistEvent(event = queuedEvent("finished"), createdAt = new Date()) {
    await db.webhookEvent.create({
      data: {
        merchantId: merchant.id,
        provider: PaymentProvider.NOWPAYMENTS.database,
        providerEventId: event.eventId,
        payload: JSON.parse(JSON.stringify(event)),
        createdAt,
      },
    });
  }

  async function getPayment(sourceOrderId = "local-order-21") {
    return db.paymentRecord.findUniqueOrThrow({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: merchant.id,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId,
        },
      },
    });
  }

  it("matches a verified direct IPN to the referral registered from the checkout response", async () => {
    await registerCheckout();
    await processEvent();

    const payment = await getPayment();
    expect(payment.clickId).toBe(clickId);
    expect(payment.checkoutId).toBeNull();
    expect(payment.checkoutRef).toBe(INVOICE_REFERENCE);
    expect(payment.saleAmount.toString()).toBe("31.25");
    expect(payment.saleCurrency).toBe("eur");
    const commission = await db.commission.findUniqueOrThrow({ where: { paymentRecordId: payment.id } });
    expect(commission.clickId).toBe(clickId);
    expect(commission.saleAmount?.toString()).toBe("31.25");
    expect(commission.amount.toString()).toBe("6.25");
    expect(await db.commerceCheckout.count()).toBe(0);
  });

  it("runs a documented mock invoice through tracking, the IPN relay, and the Supaffi worker", async () => {
    const priorEncryptionKey = process.env.MASTER_ENCRYPTION_KEY;
    process.env.MASTER_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    const invoiceRequests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
    const mockNowPayments = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      invoiceRequests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body });

      if (request.method !== "POST" || request.url !== "/v1/invoice") {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: MOCK_INVOICE_REFERENCE,
        invoice_url: `https://sandbox.nowpayments.io/payment/?iid=${MOCK_INVOICE_REFERENCE}`,
      }));
    });
    let relayServer: ReturnType<typeof createLocalRelayServer> | null = null;

    try {
      mockNowPayments.listen(0, "127.0.0.1");
      await once(mockNowPayments, "listening");
      const mockAddress = mockNowPayments.address();
      if (!mockAddress || typeof mockAddress === "string") throw new Error("Mock NOWPayments server did not bind to a TCP port");

      const connection = await db.paymentConnection.findFirstOrThrow({
        where: { merchantId: merchant.id, provider: PaymentProvider.NOWPAYMENTS.database },
        select: { id: true, webhookRouteId: true },
      });
      await db.paymentConnection.update({
        where: { id: connection.id },
        data: { webhookSecretEnc: encrypt(NOWPAYMENTS_SECRET) },
      });

      const forwardedEvents: { url: string; body: string; signature: string | null }[] = [];
      const relay = createLocalRelayServer({
        env: {
          EXISTING_WEBHOOK_URL: "http://127.0.0.1:19001/existing-webhook",
          SUPAFFI_WEBHOOK_URL: `http://127.0.0.1:19002/api/webhooks/nowpayments/${connection.webhookRouteId}`,
        },
        fetchFn: async (input, init) => {
          const url = String(input);
          const rawBody = Buffer.from(init?.body as ArrayBuffer).toString("utf8");
          const signature = new Headers(init?.headers).get("x-nowpayments-sig");
          forwardedEvents.push({ url, body: rawBody, signature });

          if (url.includes("19001")) return new Response(null, { status: 200 });
          if (!url.includes("19002")) return new Response(null, { status: 404 });

          const providerRequest = new Request(url, {
            method: "POST",
            headers: init?.headers,
            body: rawBody,
          });
          const providerResponse = await receiveNowPaymentsIpn(providerRequest, {
            params: Promise.resolve({ connectionId: connection.webhookRouteId }),
          });
          return new Response(null, { status: providerResponse.status });
        },
      });
      relayServer = relay;
      relay.listen(0, "127.0.0.1");
      await once(relay, "listening");
      const relayAddress = relay.address();
      if (!relayAddress || typeof relayAddress === "string") throw new Error("Mock IPN relay did not bind to a TCP port");

      const invoiceRequest = {
        price_amount: 31.25,
        price_currency: "eur",
        order_id: "local-order-21",
        order_description: "Product",
        success_url: "https://product.example.com/thanks",
        cancel_url: "https://product.example.com/cancel",
        ipn_callback_url: `http://127.0.0.1:${relayAddress.port}/ipn`,
      };
      const invoiceResponse = await fetch(`http://127.0.0.1:${mockAddress.port}/v1/invoice`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-api-key" },
        body: JSON.stringify(invoiceRequest),
      });
      expect(invoiceResponse.status).toBe(200);
      const invoice = await invoiceResponse.json() as { id: string; invoice_url: string };

      expect(invoiceRequests).toHaveLength(1);
      expect(invoiceRequests[0]).toMatchObject({ method: "POST", path: "/v1/invoice" });
      expect(invoiceRequests[0].headers["x-api-key"]).toBe("mock-api-key");
      expect(invoiceRequests[0].body).toEqual(invoiceRequest);
      expect(invoice).toEqual({
        id: MOCK_INVOICE_REFERENCE,
        invoice_url: `https://sandbox.nowpayments.io/payment/?iid=${MOCK_INVOICE_REFERENCE}`,
      });

      const checkoutReference = new URL(invoice.invoice_url).searchParams.get("iid");
      const attributionResponse = await registerCheckoutRoute(new Request(
        `https://${merchant.domain}/api/track/checkout-attribution`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: merchant.domain,
            origin: merchant.websiteUrl,
          },
          body: JSON.stringify({
            provider: "nowpayments",
            checkoutReference,
            referralToken: REFERRAL_TOKEN,
          }),
        }
      ));
      expect(attributionResponse.status).toBe(204);

      const providerUpdatedAt = new Date(Date.now() + 1_000).toISOString();
      const ipnPayload = {
        payment_id: 90021,
        invoice_id: invoice.id,
        payment_status: "finished",
        pay_address: "mock-address",
        price_amount: 31.25,
        price_currency: "EUR",
        pay_amount: 0.0005,
        actually_paid: 0.0005,
        pay_currency: "BTC",
        order_id: "local-order-21",
        order_description: "Product",
        purchase_id: "mock-purchase-21",
        outcome_amount: 0.00049,
        outcome_currency: "BTC",
        created_at: new Date().toISOString(),
        updated_at: providerUpdatedAt,
        network: "btc",
      };
      const signature = createHmac("sha512", NOWPAYMENTS_SECRET)
        .update(JSON.stringify(sortForSignature(ipnPayload)), "utf8")
        .digest("hex");
      const rawIpn = JSON.stringify(ipnPayload, null, 2);
      const ipnResponse = await fetch(invoiceRequest.ipn_callback_url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
        body: rawIpn,
      });
      expect(ipnResponse.status).toBe(200);
      expect(forwardedEvents).toHaveLength(2);
      expect(forwardedEvents.every((event) => event.body === rawIpn && event.signature === signature)).toBe(true);
      expect(forwardedEvents.map((event) => event.url).sort()).toEqual([
        "http://127.0.0.1:19001/existing-webhook",
        `http://127.0.0.1:19002/api/webhooks/nowpayments/${connection.webhookRouteId}`,
      ].sort());

      await runTick();

      const payment = await getPayment("local-order-21");
      expect(payment.paymentRef).toBe("90021");
      expect(payment.checkoutRef).toBe(MOCK_INVOICE_REFERENCE);
      expect(payment.status).toBe("finished");
      expect(payment.clickId).toBe(clickId);
      expect(payment.saleAmount.toString()).toBe("31.25");
      expect(payment.cryptoAmount?.toString()).toBe("0.0005");
      expect(payment.cryptoCurrency).toBe("btc");
      expect(payment.cryptoNetwork).toBe("btc");
      const commission = await db.commission.findUniqueOrThrow({ where: { paymentRecordId: payment.id } });
      expect(commission.amount.toString()).toBe("6.25");
      expect(commission.saleAmount?.toString()).toBe("31.25");
      expect(await db.webhookEvent.count({ where: { merchantId: merchant.id, status: "PROCESSED" } })).toBe(1);
    } finally {
      if (mockNowPayments.listening) {
        await new Promise<void>((resolve, reject) => mockNowPayments.close((error) => error ? reject(error) : resolve()));
      }
      const relay = relayServer;
      if (relay?.listening) {
        await new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve()));
      }
      if (priorEncryptionKey === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
      else process.env.MASTER_ENCRYPTION_KEY = priorEncryptionKey;
    }
  });

  it("records a verified payment without a commission when its invoice has no attribution mapping", async () => {
    await processEvent();

    const payment = await getPayment();
    expect(payment.clickId).toBeNull();
    expect(await db.commission.count()).toBe(0);
  });

  it("does not credit later payments made against a reused invoice", async () => {
    await registerCheckout();
    await processEvent();

    const laterPayment = queuedEvent("finished", "payment-22");
    laterPayment.rawPayload.order_id = "local-order-22";
    await processEvent(laterPayment);

    const firstPayment = await getPayment();
    const secondPayment = await getPayment("local-order-22");
    expect(firstPayment.clickId).toBe(clickId);
    expect(secondPayment.clickId).toBeNull();
    expect(await db.commission.count({ where: { paymentRecordId: firstPayment.id } })).toBe(1);
    expect(await db.commission.count({ where: { paymentRecordId: secondPayment.id } })).toBe(0);
  });

  it("accepts signed events without optional order and invoice references", async () => {
    const event = queuedEvent("finished");
    event.rawPayload.order_id = null;
    event.rawPayload.invoice_id = null;
    event.checkoutRef = null;

    await processEvent(event);

    const payment = await getPayment("payment-21");
    expect(payment.paymentRef).toBe("payment-21");
    expect(payment.checkoutRef).toBeNull();
    expect(payment.clickId).toBeNull();
    expect(await db.commission.count()).toBe(0);
  });

  it("reconciles a registered referral if a signed finished IPN was processed first", async () => {
    const event = queuedEvent("finished");
    const registrationReceivedAt = new Date(event.occurredAt.getTime() - 1_000);
    const ipnReceivedAt = new Date(event.occurredAt.getTime() + 100);
    await persistEvent(event, ipnReceivedAt);
    await processEvent(event, event.eventId, ipnReceivedAt);
    expect((await getPayment()).clickId).toBeNull();
    expect(await db.commission.count()).toBe(0);

    // Simulate a slow database insert: the server received the registration
    // before the signed payment update even though the row is written later.
    await registerCheckout(INVOICE_REFERENCE, registrationReceivedAt);
    await reconcileNowPaymentsCheckoutAttribution({
      merchantId: merchant.id,
      providerCheckoutRef: INVOICE_REFERENCE,
      clickId,
    });

    const payment = await getPayment();
    expect(payment.clickId).toBe(clickId);
    expect(await db.commission.count({ where: { paymentRecordId: payment.id, clickId } })).toBe(1);
  });

  it("does not reconcile an invoice registration received after the signed payment update", async () => {
    const event = queuedEvent("finished");
    const ipnReceivedAt = new Date(event.occurredAt.getTime() + 100);
    await persistEvent(event, ipnReceivedAt);
    await processEvent(event, event.eventId, ipnReceivedAt);

    await registerCheckout(INVOICE_REFERENCE, new Date(event.occurredAt.getTime() + 1_000));
    await reconcileNowPaymentsCheckoutAttribution({
      merchantId: merchant.id,
      providerCheckoutRef: INVOICE_REFERENCE,
      clickId,
    });

    const payment = await getPayment();
    expect(payment.clickId).toBeNull();
    expect(await db.commission.count()).toBe(0);
  });

  it("does not attribute an event whose invoice reference differs from the registered checkout", async () => {
    await registerCheckout("different-invoice");
    await processEvent();

    expect((await getPayment()).clickId).toBeNull();
    expect(await db.commission.count()).toBe(0);
  });

  it("keeps duplicate finishes idempotent and ignores an older pending status", async () => {
    await registerCheckout();
    await processEvent(queuedEvent("finished"), "finished-first");
    await processEvent(queuedEvent("finished"), "finished-replay");
    await processEvent(queuedEvent("waiting"), "late-waiting");

    const payment = await getPayment();
    expect(payment.status).toBe("finished");
    expect(payment.saleAmount.toString()).toBe("31.25");
    expect(await db.commission.count({ where: { paymentRecordId: payment.id } })).toBe(1);
  });

  it("voids the commission when the same provider payment is refunded", async () => {
    await registerCheckout();
    await processEvent(queuedEvent("finished"));
    await processEvent(queuedEvent("refunded"));

    const payment = await getPayment();
    expect(payment.status).toBe("refunded");
    expect(await db.commission.findUniqueOrThrow({ where: { paymentRecordId: payment.id } })).toMatchObject({
      status: "VOIDED",
      voidReason: "refund",
    });
    expect(await db.commerceEventDelivery.count()).toBe(0);
  });

  it("does not replace a payment with a different payment for the same order", async () => {
    await registerCheckout();
    await processEvent(queuedEvent("finished"));
    const replacement = queuedEvent("finished", "payment-22");
    await processEvent(replacement);

    const payment = await getPayment();
    expect(payment.paymentRef).toBe("payment-21");
    expect(payment.status).toBe("finished");
    expect(await db.paymentRecord.count({ where: { sourceOrderId: "local-order-21" } })).toBe(1);
    expect(await db.commission.count({ where: { paymentRecordId: payment.id } })).toBe(1);
  });
});
