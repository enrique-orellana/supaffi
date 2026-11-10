import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Merchant, WebhookEvent } from "@prisma/client";
import {
  PaymentProvider,
  type VerifiedProviderEvent,
} from "@/lib/payments/types";
import { db } from "@/lib/db";
import { listCommissions } from "@/lib/commission";
import { handleNowPaymentsEvent } from "@/lib/worker/handlers/nowpayments";

const INVOICE_REFERENCE = "fee-invoice-1";

type TestQueuedEvent = VerifiedProviderEvent & {
  paymentRef: string;
  rawPayload: Record<string, unknown>;
};

function finishedEvent(
  paymentRef: string,
  fee: Record<string, unknown>,
  saleCurrency = "eur",
): TestQueuedEvent {
  const updatedAt = new Date();
  return {
    provider: PaymentProvider.NOWPAYMENTS.id,
    eventId: `${paymentRef}:finished`,
    kind: "payment_succeeded",
    paymentRef,
    checkoutRef: INVOICE_REFERENCE,
    saleAmount: "2",
    saleCurrency,
    cryptoAmount: "2.22908376",
    cryptoCurrency: "usdt",
    occurredAt: updatedAt,
    rawPayload: {
      payment_status: "finished",
      payment_id: paymentRef,
      invoice_id: INVOICE_REFERENCE,
      order_id: `order-${paymentRef}`,
      price_amount: "2",
      price_currency: saleCurrency,
      actually_paid: "2.22908376",
      pay_currency: "usdt",
      network: "arbitrum",
      outcome_amount: "2.055646",
      outcome_currency: "usdc",
      fee,
      updated_at: updatedAt.toISOString(),
    },
  };
}

async function clearAll() {
  await db.commerceEventDelivery.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.commission.deleteMany({
    where: { adjustsCommissionId: { not: null } },
  });
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

describe("NOWPayments provider-fee commission persistence", () => {
  let merchant: Merchant;
  let ownerId: string;

  beforeEach(async () => {
    await clearAll();
    const owner = await db.owner.create({
      data: {
        email: `owner-${crypto.randomUUID()}@example.com`,
        passwordHash: "x",
      },
    });
    ownerId = owner.id;
    merchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId: owner.id,
        name: "Fee test product",
        domain: `${crypto.randomUUID()}.example.com`,
        websiteUrl: "https://product.example.com",
        paymentConnections: {
          create: {
            provider: PaymentProvider.NOWPAYMENTS.database,
            webhookSecretEnc: "not-needed-by-worker",
            status: "CONNECTED",
            enabled: true,
            feeFallbackPercent: 10,
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
        programId: affiliate.programId,
        affiliateId: affiliate.id,
        referralToken: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    });
    await db.checkoutAttribution.create({
      data: {
        merchantId: merchant.id,
        provider: PaymentProvider.NOWPAYMENTS.database,
        providerCheckoutRef: INVOICE_REFERENCE,
        clickId: click.id,
      },
    });
  });

  afterAll(async () => {
    await clearAll();
    await db.$disconnect();
  });

  async function processEvent(event: TestQueuedEvent) {
    await handleNowPaymentsEvent({
      merchantId: merchant.id,
      providerEventId: event.eventId,
      payload: JSON.parse(JSON.stringify(event)),
      createdAt: new Date(),
    } as unknown as WebhookEvent);
  }

  async function getCommission(paymentRef: string) {
    const payment = await db.paymentRecord.findUniqueOrThrow({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: merchant.id,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: `order-${paymentRef}`,
        },
      },
    });
    return db.commission.findUniqueOrThrow({
      where: { paymentRecordId: payment.id },
    });
  }

  async function getPayment(paymentRef: string) {
    return db.paymentRecord.findUniqueOrThrow({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: merchant.id,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: `order-${paymentRef}`,
        },
      },
    });
  }

  it("stores the fee on the payment only after finished and deduplicates redelivery", async () => {
    const event = finishedEvent("payment-fee-1", {
      currency: "USDC",
      depositFee: "0.13616",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    const waiting = {
      ...event,
      eventId: "payment-fee-1:waiting",
      kind: "payment_pending" as const,
      rawPayload: { ...event.rawPayload, payment_status: "waiting" },
    };

    await processEvent(waiting);
    const beforeFinished = await getPayment(event.paymentRef);
    expect(
      (beforeFinished as typeof beforeFinished & {
        providerFeeAmount?: { toString(): string } | null;
      }).providerFeeAmount ?? null,
    ).toBeNull();
    await processEvent(event);
    await processEvent(event);

    const commission = await getCommission(event.paymentRef);
    const payment = await getPayment(event.paymentRef);
    const feeFields = payment as typeof payment & {
      providerFeeAmount?: { toString(): string } | null;
      providerFeeSource?: string | null;
    };
    expect(feeFields.providerFeeSource).toBe("ACTUAL");
    expect(feeFields.providerFeeAmount?.toString()).toBe("0.12");
    expect(commission.providerFeeSource).toBeNull();
    expect(commission.providerFeeAmount).toBeNull();
    expect(commission.amount.toString()).toBe("0.37");
    const { rows } = await listCommissions(
      ownerId,
      merchant.id,
      { status: null, affiliateId: null, currency: null, query: null },
      { page: 1, pageSize: 25 },
    );
    expect(rows[0]?.providerFeeAmount).toBe("0.12");
    expect(rows[0]?.providerFeePercent).toBe("6.00");
    expect(rows[0]?.providerFeeSource).toBe("ACTUAL");
    expect(
      await db.commission.count({
        where: { paymentRecordId: commission.paymentRecordId },
      }),
    ).toBe(1);
  });

  it("floors the fee-adjusted NOWPayments commission to cents", async () => {
    const event = finishedEvent("payment-fee-eur-cents", {
      currency: "usdcsol",
      depositFee: "0.00126",
      withdrawalFee: "0",
      serviceFee: "0.022194",
    });
    event.rawPayload.outcome_currency = "usdcsol";

    await processEvent(event);

    const payment = await getPayment(event.paymentRef);
    const feeFields = payment as typeof payment & {
      providerFeeAmount?: { toString(): string } | null;
    };
    const commission = await getCommission(event.paymentRef);
    expect(feeFields.providerFeeAmount?.toString()).toBe("0.02");
    // (€2.00 - €0.02) × 20% = €0.396, floored to €0.39.
    expect(commission.amount.toString()).toBe("0.39");
  });

  it("keeps a recorded actual fee when a later finished callback has no fee", async () => {
    const event = finishedEvent("payment-fee-preserve-actual", {
      currency: "USDC",
      depositFee: "0.13616",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    await processEvent(event);

    const feeMissingEvent = {
      ...event,
      eventId: `owner-reconcile:${"a".repeat(64)}`,
      reconciliation: true,
      rawPayload: { ...event.rawPayload, fee: {} },
    };
    await processEvent(feeMissingEvent);

    const payment = await getPayment(event.paymentRef);
    const feeFields = payment as typeof payment & {
      providerFeeAmount?: { toString(): string } | null;
      providerFeeSource?: string | null;
    };
    expect(feeFields.providerFeeSource).toBe("ACTUAL");
    expect(feeFields.providerFeeAmount?.toString()).toBe("0.12");
  });

  it("uses the configured fallback when the fee currency cannot be reconciled", async () => {
    const event = finishedEvent("payment-fee-fallback", {
      currency: "BTC",
      depositFee: "0.001",
      withdrawalFee: "0",
      serviceFee: "0",
    });

    await processEvent(event);

    const commission = await getCommission(event.paymentRef);
    const payment = await getPayment(event.paymentRef);
    const feeFields = payment as typeof payment & {
      providerFeeAmount?: { toString(): string } | null;
      providerFeeSource?: string | null;
    };
    expect(feeFields.providerFeeSource).toBe("FALLBACK");
    expect(feeFields.providerFeeAmount?.toString()).toBe("0.2");
    expect(commission.providerFeeSource).toBeNull();
    expect(commission.providerFeeAmount).toBeNull();
    expect(commission.amount.toString()).toBe("0.36");
  });

  it("preserves a three-decimal fee when listing commissions", async () => {
    const event = finishedEvent(
      "payment-fee-three-decimal",
      {
        currency: "KWD",
        depositFee: "0.003",
        withdrawalFee: "0",
        serviceFee: "0",
      },
      "KWD",
    );

    await processEvent(event);

    const { rows } = await listCommissions(
      ownerId,
      merchant.id,
      { status: null, affiliateId: null, currency: null, query: null },
      { page: 1, pageSize: 25 },
    );

    expect(rows[0]?.providerFeeAmount).toBe("0.003");
    expect(rows[0]?.providerFeeSource).toBe("ACTUAL");
  });
});
