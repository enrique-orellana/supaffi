import { PaymentProvider } from "@/lib/payments/types";
import { createHash, createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CommerceEventDelivery } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";
import { SqlSchema } from "@/lib/sqlSchema";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 20;
const CLAIM_LEASE_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 4 * 60 * 60_000;

/** Add a normalized event to the outbox inside its payment transaction. */
export async function enqueueCommerceEvent(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    /** Stable provider/event identity within this Merchant across retries. */
    eventId: string;
    payload: Prisma.InputJsonObject;
  }
): Promise<void> {
  if (!/^[a-z\d:_-]{1,200}$/i.test(input.eventId)) {
    throw new Error("Invalid commerce event ID");
  }

  const integration = await tx.commerceIntegration.findUnique({
    where: { merchantId: input.merchantId },
    select: { id: true, eventDestination: true },
  });
  if (!integration?.eventDestination) return;

  // The database eventId is globally unique, so namespace the caller's stable
  // provider/event identity with its Merchant before persisting it.
  const eventId = `evt_${createHash("sha256")
    .update(input.merchantId, "utf8")
    .update("\0", "utf8")
    .update(input.eventId, "utf8")
    .digest("hex")}`;

  await tx.commerceEventDelivery.createMany({
    data: [{
      merchantId: input.merchantId,
      integrationId: integration.id,
      eventId,
      payload: input.payload,
    }],
    skipDuplicates: true,
  });
}

/** Claim a bounded batch, recovering PROCESSING rows after their lease expires. */
async function claimCommerceDeliveryBatch(): Promise<CommerceEventDelivery[]> {
  await db.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name}
    SET ${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED',
        ${SqlSchema.tables.CommerceEventDelivery.lastError} = COALESCE(
          ${SqlSchema.tables.CommerceEventDelivery.lastError},
          'The worker stopped while delivering this event.'
        )
    WHERE ${SqlSchema.tables.CommerceEventDelivery.status} = 'PROCESSING'
      AND ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} <= now()
      AND ${SqlSchema.tables.CommerceEventDelivery.attempts} >= ${MAX_ATTEMPTS};
  `);

  return db.$queryRaw<CommerceEventDelivery[]>(Prisma.sql`
    WITH claimed AS (
      SELECT ${SqlSchema.tables.CommerceEventDelivery.id}
      FROM ${SqlSchema.tables.CommerceEventDelivery.name}
      WHERE ${SqlSchema.tables.CommerceEventDelivery.status} IN ('PENDING', 'PROCESSING')
        AND ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} IS NULL
        AND ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} <= now()
        AND ${SqlSchema.tables.CommerceEventDelivery.attempts} < ${MAX_ATTEMPTS}
      ORDER BY ${SqlSchema.tables.CommerceEventDelivery.createdAt} ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    )
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name} delivery
    SET ${SqlSchema.tables.CommerceEventDelivery.status} = 'PROCESSING',
        ${SqlSchema.tables.CommerceEventDelivery.attempts} = delivery.${SqlSchema.tables.CommerceEventDelivery.attempts} + 1,
        ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} = now() + ${CLAIM_LEASE_SECONDS} * interval '1 second'
    FROM claimed
    WHERE delivery.${SqlSchema.tables.CommerceEventDelivery.id} = claimed.${SqlSchema.tables.CommerceEventDelivery.id}
    RETURNING delivery.*;
  `);
}

function referenceNoticeId(sourceOrderId: string, status: "invoice_conflict" | "invoice_reconciled", refs: string[]): string {
  const orderHash = createHash("sha256").update(sourceOrderId, "utf8").digest("hex");
  const refsHash = createHash("sha256").update([...new Set(refs)].sort().join("\0"), "utf8").digest("hex");
  return `nowpayments-order:${orderHash}:${status}:${refsHash}`;
}

type CommercePaymentSnapshot = {
  paymentRef: string;
  status: string;
  saleAmount: string;
  saleCurrency: string;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  cryptoNetwork: string | null;
};

async function paymentSnapshot(
  tx: Prisma.TransactionClient,
  merchantId: string,
  sourceOrderId: string
): Promise<CommercePaymentSnapshot | null> {
  const payment = await tx.paymentRecord.findUnique({
    where: { merchantId_provider_sourceOrderId: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database, sourceOrderId } },
    select: {
      paymentRef: true,
      status: true,
      saleAmount: true,
      saleCurrency: true,
      cryptoAmount: true,
      cryptoCurrency: true,
      cryptoNetwork: true,
    },
  });
  if (!payment) return null;
  return {
    paymentRef: payment.paymentRef,
    status: payment.status.toLowerCase(),
    saleAmount: payment.saleAmount.toString(),
    saleCurrency: payment.saleCurrency,
    cryptoAmount: payment.cryptoAmount?.toString() ?? null,
    cryptoCurrency: payment.cryptoCurrency,
    cryptoNetwork: payment.cryptoNetwork,
  };
}

async function enqueueCheckoutReferenceNotice(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    sourceOrderId: string;
    paymentRef: string | null;
    status: "invoice_conflict" | "invoice_reconciled";
    primaryRef: string | null;
    alternateRef: string | null;
    additionalRefs?: string[];
    selectedRef?: string;
    payment?: CommercePaymentSnapshot | null;
  }
): Promise<void> {
  const refs = [input.primaryRef, input.alternateRef, input.selectedRef, ...(input.additionalRefs ?? [])]
    .filter((ref): ref is string => Boolean(ref));
  const eventId = referenceNoticeId(
    input.sourceOrderId,
    input.status,
    [
      ...refs,
      `payment:${input.payment?.paymentRef ?? input.paymentRef ?? "unknown"}`,
      `paymentStatus:${input.payment?.status ?? "unknown"}`,
    ]
  );
  await enqueueCommerceEvent(tx, {
    merchantId: input.merchantId,
    eventId,
    payload: {
      provider: PaymentProvider.NOWPAYMENTS.id,
      eventId,
      status: input.status,
      sourceOrderId: input.sourceOrderId,
      paymentRef: input.payment?.paymentRef ?? input.paymentRef,
      checkoutRef: input.primaryRef,
      alternateCheckoutRef: input.alternateRef,
      selectedInvoiceRef: input.selectedRef ?? null,
      conflictingInvoiceRefs: input.status === "invoice_conflict" ? [...new Set(refs)] : [],
      paymentStatus: input.payment?.status ?? null,
      saleAmount: input.payment?.saleAmount ?? null,
      saleCurrency: input.payment?.saleCurrency ?? null,
      cryptoAmount: input.payment?.cryptoAmount ?? null,
      cryptoCurrency: input.payment?.cryptoCurrency ?? null,
      cryptoNetwork: input.payment?.cryptoNetwork ?? null,
      occurredAt: new Date().toISOString(),
    },
  });
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, normalize(record[key])])
      );
    }
    return current;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error("Commerce event payload is not serializable");
  return serialized;
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function markCommerceDeliveryDelivered(id: string, attempts: number): Promise<void> {
  const heldOrder = await db.$transaction(async (tx) => {
    const updated = await tx.commerceEventDelivery.updateMany({
      where: { id, status: "PROCESSING", attempts },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        lastError: null,
      },
    });
    if (updated.count !== 1) return null;

    const delivery = await tx.commerceEventDelivery.findUnique({
      where: { id },
      select: { merchantId: true, payload: true, checkoutConflictHeldAt: true },
    });
    if (!delivery?.checkoutConflictHeldAt || !delivery.payload || typeof delivery.payload !== "object" || Array.isArray(delivery.payload)) return null;

    const payload = delivery.payload as Prisma.JsonObject;
    const sourceOrderId = payload.sourceOrderId;
    if (typeof sourceOrderId !== "string" || payload.provider !== PaymentProvider.NOWPAYMENTS.id) return null;
    const checkout = await tx.commerceCheckout.findUnique({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: delivery.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId,
        },
      },
      select: {
        status: true,
        hostedCheckoutRef: true,
        alternateCheckoutRef: true,
        reconciliationResolution: true,
        refundReconciliationPendingAt: true,
      },
    });

    if (checkout && (checkout.status === "UNCERTAIN" || checkout.alternateCheckoutRef)) {
      const payment = await paymentSnapshot(tx, delivery.merchantId, sourceOrderId);
      await enqueueCheckoutReferenceNotice(tx, {
        merchantId: delivery.merchantId,
        sourceOrderId,
        paymentRef: typeof payload.paymentRef === "string" ? payload.paymentRef : null,
        status: "invoice_conflict",
        primaryRef: checkout.hostedCheckoutRef,
        alternateRef: checkout.alternateCheckoutRef,
        additionalRefs: typeof payload.checkoutRef === "string" ? [payload.checkoutRef] : [],
        payment,
      });
    } else if (
      checkout?.status === "READY" &&
      checkout.reconciliationResolution === "FOUND" &&
      !checkout.refundReconciliationPendingAt
    ) {
      const payment = await paymentSnapshot(tx, delivery.merchantId, sourceOrderId);
      await enqueueCheckoutReferenceNotice(tx, {
        merchantId: delivery.merchantId,
        sourceOrderId,
        paymentRef: typeof payload.paymentRef === "string" ? payload.paymentRef : null,
        status: "invoice_reconciled",
        primaryRef: checkout.hostedCheckoutRef,
        alternateRef: checkout.alternateCheckoutRef,
        selectedRef: checkout.hostedCheckoutRef ?? undefined,
        payment,
      });
    } else if (
      checkout?.status === "READY" &&
      checkout.reconciliationResolution === "FOUND" &&
      checkout.refundReconciliationPendingAt
    ) {
      // A verified refund has been queued; retain the hold until it is applied.
      return null;
    }
    await tx.commerceEventDelivery.updateMany({
      where: { id, checkoutConflictHeldAt: { not: null } },
      data: { checkoutConflictHeldAt: null },
    });
    return {
      merchantId: delivery.merchantId,
      sourceOrderId,
      paymentRef: typeof payload.paymentRef === "string" ? payload.paymentRef : null,
    };
  });

  // Close the race where an owner resolves the checkout while this delivery
  // is completing. The resolver either observed PROCESSING, or this follow-up
  // sees the committed resolution; the stable event ID deduplicates both.
  if (heldOrder) {
    await db.$transaction(async (tx) => {
      const checkout = await tx.commerceCheckout.findUnique({
        where: {
          merchantId_provider_sourceOrderId: {
            merchantId: heldOrder.merchantId,
            provider: PaymentProvider.NOWPAYMENTS.database,
            sourceOrderId: heldOrder.sourceOrderId,
          },
        },
        select: {
          status: true,
          hostedCheckoutRef: true,
          alternateCheckoutRef: true,
          reconciliationResolution: true,
          refundReconciliationPendingAt: true,
        },
      });
      if (
        checkout?.status !== "READY" ||
        checkout.reconciliationResolution !== "FOUND" ||
        checkout.refundReconciliationPendingAt
      ) return;
      const payment = await paymentSnapshot(tx, heldOrder.merchantId, heldOrder.sourceOrderId);
      await enqueueCheckoutReferenceNotice(tx, {
        merchantId: heldOrder.merchantId,
        sourceOrderId: heldOrder.sourceOrderId,
        paymentRef: heldOrder.paymentRef,
        status: "invoice_reconciled",
        primaryRef: checkout.hostedCheckoutRef,
        alternateRef: checkout.alternateCheckoutRef,
        selectedRef: checkout.hostedCheckoutRef ?? undefined,
        payment,
      });
    });
  }
}

async function markCommerceDeliveryFailed(
  id: string,
  attempts: number,
  error: unknown
): Promise<void> {
  const terminal = attempts >= MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : "Commerce event delivery failed";
  await db.$transaction(async (tx) => {
    const delivery = await tx.commerceEventDelivery.findUnique({
      where: { id },
      select: { merchantId: true, payload: true, checkoutConflictHeldAt: true, status: true, attempts: true },
    });
    if (!delivery || delivery.status !== "PROCESSING" || delivery.attempts !== attempts) return;

    if (delivery.checkoutConflictHeldAt && delivery.payload && typeof delivery.payload === "object" && !Array.isArray(delivery.payload)) {
      const payload = delivery.payload as Prisma.JsonObject;
      const sourceOrderId = payload.sourceOrderId;
      if (payload.provider === PaymentProvider.NOWPAYMENTS.id && typeof sourceOrderId === "string") {
        await tx.$queryRaw(Prisma.sql`
          SELECT ${SqlSchema.tables.CommerceCheckout.id}
          FROM ${SqlSchema.tables.CommerceCheckout.name}
          WHERE ${SqlSchema.tables.CommerceCheckout.merchantId} = ${delivery.merchantId}
            AND ${SqlSchema.tables.CommerceCheckout.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
            AND ${SqlSchema.tables.CommerceCheckout.sourceOrderId} = ${sourceOrderId}
          FOR UPDATE
        `);
        const checkout = await tx.commerceCheckout.findUnique({
          where: {
            merchantId_provider_sourceOrderId: {
              merchantId: delivery.merchantId,
              provider: PaymentProvider.NOWPAYMENTS.database,
              sourceOrderId,
            },
          },
          select: {
            status: true,
            hostedCheckoutRef: true,
            alternateCheckoutRef: true,
            reconciliationResolution: true,
            refundReconciliationPendingAt: true,
          },
        });
        if (checkout?.status === "READY" && checkout.reconciliationResolution === "FOUND") {
          const payment = await paymentSnapshot(tx, delivery.merchantId, sourceOrderId);
          const isWaitingForRefund = Boolean(checkout.refundReconciliationPendingAt);
          if (!isWaitingForRefund) {
            await enqueueCheckoutReferenceNotice(tx, {
              merchantId: delivery.merchantId,
              sourceOrderId,
              paymentRef: typeof payload.paymentRef === "string" ? payload.paymentRef : null,
              status: "invoice_reconciled",
              primaryRef: checkout.hostedCheckoutRef,
              alternateRef: checkout.alternateCheckoutRef,
              selectedRef: checkout.hostedCheckoutRef ?? undefined,
              payment,
            });
          }
          await tx.commerceEventDelivery.updateMany({
            where: { id, status: "PROCESSING", attempts, checkoutConflictHeldAt: { not: null } },
            data: {
              // Keep the original request body/event ID immutable. The
              // reconciliation notice has a distinct event ID and terminal
              // payment snapshot for receivers that missed this POST.
              checkoutConflictHeldAt: isWaitingForRefund ? delivery.checkoutConflictHeldAt : null,
              status: "FAILED",
              lastError: message.slice(0, 1000),
              nextAttemptAt: new Date(),
            },
          });
          return;
        }

        if (checkout) {
          const payment = await paymentSnapshot(tx, delivery.merchantId, sourceOrderId);
          await enqueueCheckoutReferenceNotice(tx, {
            merchantId: delivery.merchantId,
            sourceOrderId,
            paymentRef: typeof payload.paymentRef === "string" ? payload.paymentRef : null,
            status: "invoice_conflict",
            primaryRef: checkout.hostedCheckoutRef,
            alternateRef: checkout.alternateCheckoutRef,
            additionalRefs: typeof payload.checkoutRef === "string" ? [payload.checkoutRef] : [],
            payment,
          });
        }
      }
    }

    await tx.commerceEventDelivery.updateMany({
      where: { id, status: "PROCESSING", attempts },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        lastError: message.slice(0, 1000),
        nextAttemptAt: terminal ? new Date() : new Date(Date.now() + backoffMs(attempts)),
      },
    });
  });
}

async function deliverCommerceEvent(delivery: CommerceEventDelivery): Promise<void> {
  const integration = await db.commerceIntegration.findFirst({
    where: { id: delivery.integrationId, merchantId: delivery.merchantId },
    select: { secretEnc: true, eventDestination: true },
  });
  if (!integration?.eventDestination) throw new Error("Commerce event destination is not configured");

  const destination = await publicHttpsUrl(integration.eventDestination);
  if (!destination) throw new Error("Commerce event destination failed the public HTTPS check");

  let secret: string;
  try {
    secret = decrypt(integration.secretEnc);
  } catch {
    throw new Error("Commerce event signing secret cannot be read");
  }

  // The event ID is inside the signed bytes and also sent as a header so the
  // receiver can deduplicate deliveries even when a retry gets a new timestamp.
  const body = stableJson({ id: delivery.eventId, data: delivery.payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");

  let response: Response;
  try {
    response = await fetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-commerce-event-id": delivery.eventId,
        "x-commerce-timestamp": timestamp,
        "x-commerce-signature": signature,
      },
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Commerce event request failed or timed out");
  }
  try {
    await response.body?.cancel();
  } catch {
    // The status is still enough to determine delivery success; do not retain
    // a potentially large response body if the peer closes the stream badly.
  }
  if (!response.ok) throw new Error(`Commerce endpoint returned HTTP ${response.status}`);
}

/** Deliver one bounded batch; a crash leaves rows to be reclaimed after the lease. */
export async function processCommerceDeliveryBatch(): Promise<void> {
  const batch = await claimCommerceDeliveryBatch();
  for (const delivery of batch) {
    try {
      await deliverCommerceEvent(delivery);
      await markCommerceDeliveryDelivered(delivery.id, delivery.attempts);
    } catch (error) {
      await markCommerceDeliveryFailed(delivery.id, delivery.attempts, error);
      console.error(`[worker] commerce event ${delivery.eventId} delivery failed`,
        error instanceof Error ? error.message : "unknown error");
    }
  }
}
