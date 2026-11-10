import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Merchant, WebhookEvent } from "@prisma/client";
import {
  PaymentProvider,
  type VerifiedProviderEvent,
} from "@/lib/payments/types";
import { db } from "@/lib/db";
import { handleNowPaymentsEvent } from "@/lib/worker/handlers/nowpayments";
import { lockPayoutEligibilityGroup } from "@/lib/payoutEligibility";

const INVOICE_REFERENCE = "fee-persistence-adversarial-invoice";

type TestQueuedEvent = VerifiedProviderEvent & {
  paymentRef: string;
  rawPayload: Record<string, unknown>;
  reconciliation?: true;
};

function finishedEvent(paymentRef: string, fee: Record<string, unknown>) {
  const updatedAt = new Date();
  return {
    provider: PaymentProvider.NOWPAYMENTS.id,
    eventId: `${paymentRef}:finished`,
    kind: "payment_succeeded" as const,
    paymentRef,
    checkoutRef: INVOICE_REFERENCE,
    saleAmount: "2",
    saleCurrency: "eur",
    cryptoAmount: "2.22908376",
    cryptoCurrency: "usdt",
    occurredAt: updatedAt,
    rawPayload: {
      payment_status: "finished",
      payment_id: paymentRef,
      invoice_id: INVOICE_REFERENCE,
      order_id: `order-${paymentRef}`,
      price_amount: "2",
      price_currency: "eur",
      actually_paid: "2.22908376",
      pay_currency: "usdt",
      network: "arbitrum",
      outcome_amount: "2.055646",
      outcome_currency: "usdc",
      fee,
      updated_at: updatedAt.toISOString(),
    },
  } satisfies TestQueuedEvent;
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

async function waitForAdvisoryLockWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await db.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      ) AS waiting
    `;
    if (activity?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "NOWPayments fee correction did not wait for the payout lock",
  );
}

describe("NOWPayments provider-fee persistence under replay", () => {
  let merchant: Merchant;

  beforeEach(async () => {
    await clearAll();
    const owner = await db.owner.create({
      data: {
        email: `owner-${crypto.randomUUID()}@example.com`,
        passwordHash: "x",
      },
    });
    merchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId: owner.id,
        name: "Provider fee persistence test",
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

  async function getPaymentAndCommission(paymentRef: string) {
    const payment = await db.paymentRecord.findUniqueOrThrow({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: merchant.id,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: `order-${paymentRef}`,
        },
      },
    });
    const commission = await db.commission.findUniqueOrThrow({
      where: { paymentRecordId: payment.id },
    });
    return { payment, commission };
  }

  it("keeps the captured fallback fee when a replay follows a settings change", async () => {
    const event = finishedEvent("fee-fallback-replay", {
      currency: "BTC",
      depositFee: "0.001",
      withdrawalFee: "0",
      serviceFee: "0",
    });

    await processEvent(event);
    const beforeReplay = await getPaymentAndCommission(event.paymentRef);
    expect(beforeReplay.payment.providerFeeSource).toBe("FALLBACK");
    expect(beforeReplay.payment.providerFeeAmount?.toString()).toBe("0.2");
    expect(beforeReplay.commission.amount.toString()).toBe("0.36");

    await db.paymentConnection.update({
      where: {
        merchantId_provider: {
          merchantId: merchant.id,
          provider: PaymentProvider.NOWPAYMENTS.database,
        },
      },
      data: { feeFallbackPercent: 20 },
    });
    // The queue payload parser requires the provider event id to match the
    // payment reference and status. Redeliver the same valid payload here.
    await processEvent(event);

    const afterReplay = await getPaymentAndCommission(event.paymentRef);
    expect(afterReplay.payment.providerFeeSource).toBe("FALLBACK");
    expect(afterReplay.payment.providerFeeAmount?.toString()).toBe("0.2");
    expect(afterReplay.commission.amount.toString()).toBe("0.36");
  });

  it("recalculates an existing pending commission when actual fee replaces fallback", async () => {
    const initialEvent = finishedEvent("fee-fallback-upgrade", {
      currency: "BTC",
      depositFee: "0.001",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    await processEvent(initialEvent);

    const beforeUpgrade = await getPaymentAndCommission(
      initialEvent.paymentRef,
    );
    expect(beforeUpgrade.payment.providerFeeSource).toBe("FALLBACK");
    expect(beforeUpgrade.payment.providerFeeAmount?.toString()).toBe("0.2");
    expect(beforeUpgrade.commission.status).toBe("PENDING");
    expect(beforeUpgrade.commission.amount.toString()).toBe("0.36");

    const actualFeeEvent = finishedEvent(initialEvent.paymentRef, {
      currency: "EUR",
      depositFee: "0.05",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    await processEvent({
      ...actualFeeEvent,
      eventId: `owner-reconcile:${"a".repeat(64)}`,
      reconciliation: true,
    });

    const afterUpgrade = await getPaymentAndCommission(initialEvent.paymentRef);
    expect(afterUpgrade.payment.providerFeeSource).toBe("ACTUAL");
    expect(afterUpgrade.payment.providerFeeAmount?.toString()).toBe("0.05");
    expect(afterUpgrade.commission.status).toBe("PENDING");
    expect(afterUpgrade.commission.amount.toString()).toBe("0.39");
    expect(
      await db.commission.count({
        where: { paymentRecordId: afterUpgrade.payment.id },
      }),
    ).toBe(1);
  });

  it("does not rewrite a commission paid while a fee correction waits for its payout lock", async () => {
    const initialEvent = finishedEvent("fee-payout-lock-race", {
      currency: "BTC",
      depositFee: "0.001",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    await processEvent(initialEvent);

    const beforeCorrection = await getPaymentAndCommission(
      initialEvent.paymentRef,
    );
    const group = {
      merchantId: merchant.id,
      affiliateId: beforeCorrection.commission.affiliateId,
      programId: beforeCorrection.commission.programId!,
      currency: beforeCorrection.commission.currency,
    };

    let unlockPayoutGroup!: () => void;
    let payoutGroupLocked!: () => void;
    const releasePayoutGroup = new Promise<void>((resolve) => {
      unlockPayoutGroup = resolve;
    });
    const payoutGroupReady = new Promise<void>((resolve) => {
      payoutGroupLocked = resolve;
    });
    const payoutTransaction = db.$transaction(async (tx) => {
      await lockPayoutEligibilityGroup(tx, group);
      payoutGroupLocked();
      await releasePayoutGroup;
      await tx.commission.update({
        where: { id: beforeCorrection.commission.id },
        data: { status: "PAID", paidAt: new Date() },
      });
    });
    await payoutGroupReady;

    const actualFeeEvent = finishedEvent(initialEvent.paymentRef, {
      currency: "EUR",
      depositFee: "0.05",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    const feeCorrection = processEvent({
      ...actualFeeEvent,
      eventId: `owner-reconcile:${"b".repeat(64)}`,
      reconciliation: true,
    });

    try {
      await waitForAdvisoryLockWait();
    } finally {
      unlockPayoutGroup();
    }
    await payoutTransaction;
    await feeCorrection;

    const afterCorrection = await getPaymentAndCommission(
      initialEvent.paymentRef,
    );
    expect(afterCorrection.payment.providerFeeSource).toBe("ACTUAL");
    expect(afterCorrection.payment.providerFeeAmount?.toString()).toBe("0.05");
    expect(afterCorrection.commission.status).toBe("PAID");
    expect(afterCorrection.commission.amount.toString()).toBe("0.36");
    expect(afterCorrection.commission.grossAmount?.toString()).toBe("0.36");
  });

  it("moves a payable commission back to pending when a corrected fee leaves no commission", async () => {
    const initialEvent = finishedEvent("fee-zero-payout-lock-race", {
      currency: "BTC",
      depositFee: "0.001",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    await processEvent(initialEvent);

    const beforeCorrection = await getPaymentAndCommission(
      initialEvent.paymentRef,
    );
    const group = {
      merchantId: merchant.id,
      affiliateId: beforeCorrection.commission.affiliateId,
      programId: beforeCorrection.commission.programId!,
      currency: beforeCorrection.commission.currency,
    };

    let unlockPayoutGroup!: () => void;
    let payoutGroupLocked!: () => void;
    const releasePayoutGroup = new Promise<void>((resolve) => {
      unlockPayoutGroup = resolve;
    });
    const payoutGroupReady = new Promise<void>((resolve) => {
      payoutGroupLocked = resolve;
    });
    const payoutTransaction = db.$transaction(async (tx) => {
      await lockPayoutEligibilityGroup(tx, group);
      payoutGroupLocked();
      await releasePayoutGroup;
      await tx.commission.update({
        where: { id: beforeCorrection.commission.id },
        data: { status: "PAYABLE" },
      });
    });
    await payoutGroupReady;

    const actualFeeEvent = finishedEvent(initialEvent.paymentRef, {
      currency: "EUR",
      depositFee: "2",
      withdrawalFee: "0",
      serviceFee: "0",
    });
    const feeCorrection = processEvent({
      ...actualFeeEvent,
      eventId: `owner-reconcile:${"c".repeat(64)}`,
      reconciliation: true,
    });

    try {
      await waitForAdvisoryLockWait();
    } finally {
      unlockPayoutGroup();
    }
    await payoutTransaction;
    await feeCorrection;

    const afterCorrection = await getPaymentAndCommission(
      initialEvent.paymentRef,
    );
    expect(afterCorrection.payment.providerFeeAmount?.toString()).toBe("2");
    expect(afterCorrection.commission.status).toBe("PENDING");
    expect(afterCorrection.commission.amount.toString()).toBe("0");
    expect(afterCorrection.commission.grossAmount?.toString()).toBe("0");
  });
});
