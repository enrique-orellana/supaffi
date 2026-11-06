import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { enqueueCommerceEvent } from "@/lib/commerceOutbox";

type CheckoutReferenceRow = {
  merchantId: string;
  sourceOrderId: string;
  status: string;
  hostedCheckoutRef: string | null;
  alternateCheckoutRef: string | null;
};

const UNRESOLVED_REFERENCE_MESSAGE = "Multiple provider invoice references require reconciliation";
const PENDING_REFERENCE_MESSAGE = "Provider invoice reference received before checkout creation settled";

function orderDigest(sourceOrderId: string): string {
  return createHash("sha256").update(sourceOrderId, "utf8").digest("hex");
}

function refDigest(refs: string[]): string {
  return createHash("sha256").update([...new Set(refs)].sort().join("\0"), "utf8").digest("hex");
}

export async function holdUnpaidCheckoutCommissions(tx: Prisma.TransactionClient, checkoutId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Commission" AS commission
    SET "checkoutConflictHeldAt" = COALESCE(commission."checkoutConflictHeldAt", now()),
        "status" = CASE
          WHEN commission."status" = 'PAYABLE'::"CommissionStatus" THEN 'PENDING'::"CommissionStatus"
          ELSE commission."status"
        END
    FROM "PaymentRecord" AS payment
    WHERE payment."checkoutId" = ${checkoutId}
      AND payment."id" = commission."paymentRecordId"
      AND commission."status" IN (
        'PENDING'::"CommissionStatus",
        'PAYABLE'::"CommissionStatus",
        'FLAGGED'::"CommissionStatus"
      )
  `;
}

export async function holdCheckoutDeliveries(
  tx: Prisma.TransactionClient,
  merchantId: string,
  sourceOrderId: string
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "CommerceEventDelivery"
    SET "checkoutConflictHeldAt" = COALESCE("checkoutConflictHeldAt", now())
    WHERE "merchantId" = ${merchantId}
      AND "payload"->>'provider' = 'nowpayments'
      AND "payload"->>'sourceOrderId' = ${sourceOrderId}
      AND "payload"->>'status' IN ('finished', 'refunded')
      AND "status" IN (
        'PENDING'::"CommerceEventDeliveryStatus",
        'PROCESSING'::"CommerceEventDeliveryStatus",
        'FAILED'::"CommerceEventDeliveryStatus"
      )
  `;
}

async function enqueueReferenceNotice(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    sourceOrderId: string;
    paymentRef: string | null;
    status: "invoice_conflict" | "invoice_reconciled";
    primaryRef: string | null;
    alternateRef: string | null;
    selectedRef?: string;
    conflictingRefs?: string[];
    payment?: {
      status: string;
      saleAmount: string;
      saleCurrency: string;
      cryptoAmount: string | null;
      cryptoCurrency: string | null;
      cryptoNetwork: string | null;
    } | null;
  }
): Promise<void> {
  const refs = [input.primaryRef, input.alternateRef, input.selectedRef, ...(input.conflictingRefs ?? [])].filter(
    (ref): ref is string => Boolean(ref)
  );
  const digest = refDigest([
    ...refs,
    `payment:${input.paymentRef ?? "unknown"}`,
    `paymentStatus:${input.payment?.status ?? "unknown"}`,
  ]);
  const eventId = `nowpayments-order:${orderDigest(input.sourceOrderId)}:${input.status}:${digest}`;
  await enqueueCommerceEvent(tx, {
    merchantId: input.merchantId,
    eventId,
    payload: {
      provider: "nowpayments",
      eventId,
      status: input.status,
      sourceOrderId: input.sourceOrderId,
      paymentRef: input.paymentRef,
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

export async function releaseCheckoutConflictHold(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  merchantId: string,
  sourceOrderId: string,
  selectedRef: string,
  appliedTerminalStatus: "finished" | "refunded",
  terminalSnapshot: {
    paymentRef: string;
    invoiceRef: string | null;
    status: string;
    saleAmount: string;
    saleCurrency: string;
    cryptoAmount: string | null;
    cryptoCurrency: string | null;
    cryptoNetwork: string | null;
  }
): Promise<void> {
  const now = new Date();
  const checkout = await tx.commerceCheckout.findUnique({
    where: { id: checkoutId },
    select: { refundReconciliationPendingAt: true },
  });
  if (!checkout) return;
  if (checkout.refundReconciliationPendingAt && appliedTerminalStatus !== "refunded") return;

  const payment = await tx.paymentRecord.findUnique({
    where: { merchantId_provider_sourceOrderId: { merchantId, provider: "NOWPAYMENTS", sourceOrderId } },
    select: {
      paymentRef: true,
      checkoutRef: true,
      checkoutId: true,
      status: true,
      saleAmount: true,
      saleCurrency: true,
      cryptoAmount: true,
      cryptoCurrency: true,
      cryptoNetwork: true,
    },
  });
  const paymentMatchesSelectedInvoice = Boolean(
    payment &&
    payment.checkoutId === checkoutId &&
    payment.checkoutRef === selectedRef
  );
  const paymentMatchesSelectedPayment = Boolean(
    paymentMatchesSelectedInvoice &&
    payment?.paymentRef === terminalSnapshot.paymentRef
  );
  if (!payment || !paymentMatchesSelectedPayment) return;
  if (
    !["finished", "refunded"].includes(terminalSnapshot.status) ||
    terminalSnapshot.status !== appliedTerminalStatus ||
    (terminalSnapshot.invoiceRef !== null && terminalSnapshot.invoiceRef !== selectedRef)
  ) return;
  const storedPaymentStatus = payment.status.toLowerCase();
  if (!["finished", "refunded"].includes(storedPaymentStatus)) return;
  const finalStatus = appliedTerminalStatus;
  if (appliedTerminalStatus && storedPaymentStatus !== appliedTerminalStatus) return;
  const selectedPaymentRef = payment.paymentRef;
  if (appliedTerminalStatus === "refunded") {
    await tx.commerceCheckout.updateMany({
      where: { id: checkoutId, refundReconciliationPendingAt: { not: null } },
      data: { refundReconciliationPendingAt: null },
    });
  }
  const noticePayment = {
    status: finalStatus,
    saleAmount: payment.saleAmount.toString(),
    saleCurrency: payment.saleCurrency,
    cryptoAmount: payment.cryptoAmount?.toString() ?? terminalSnapshot?.cryptoAmount ?? null,
    cryptoCurrency: payment.cryptoCurrency ?? terminalSnapshot?.cryptoCurrency ?? null,
    cryptoNetwork: payment.cryptoNetwork ?? terminalSnapshot?.cryptoNetwork ?? null,
  };
  const noticePaymentRef = payment.paymentRef;

  if (payment && paymentMatchesSelectedPayment) {
    if (finalStatus === "refunded") {
      await tx.$executeRaw`
        UPDATE "Commission" AS commission
        SET "checkoutConflictHeldAt" = NULL
        FROM "PaymentRecord" AS payment
        WHERE payment."checkoutId" = ${checkoutId}
          AND payment."id" = ${payment.id}
          AND payment."paymentRef" = ${selectedPaymentRef}
          AND payment."checkoutRef" = ${selectedRef}
          AND payment."id" = commission."paymentRecordId"
          AND commission."checkoutConflictHeldAt" IS NOT NULL
          AND commission."status" = 'VOIDED'::"CommissionStatus"
      `;
    } else {
      await tx.$executeRaw`
        UPDATE "Commission" AS commission
        SET "checkoutConflictHeldAt" = NULL,
            "status" = CASE
              WHEN commission."status" = 'PENDING'::"CommissionStatus"
                AND commission."payableAt" <= ${now}
                AND commission."disputeOpenedAt" IS NULL
                THEN 'PAYABLE'::"CommissionStatus"
              ELSE commission."status"
            END
        FROM "PaymentRecord" AS payment
        WHERE payment."checkoutId" = ${checkoutId}
          AND payment."id" = ${payment.id}
          AND payment."paymentRef" = ${selectedPaymentRef}
          AND payment."checkoutRef" = ${selectedRef}
          AND payment."id" = commission."paymentRecordId"
          AND commission."checkoutConflictHeldAt" IS NOT NULL
          AND commission."status" IN (
            'PENDING'::"CommissionStatus",
            'PAYABLE'::"CommissionStatus",
            'FLAGGED'::"CommissionStatus",
            'VOIDED'::"CommissionStatus"
          )
      `;
    }
  }

  // A body is immutable once a request may have reached the receiver. Only
  // never-attempted terminal events can be linked and released in place.
  await tx.$executeRaw`
    UPDATE "CommerceEventDelivery"
    SET "payload" = jsonb_set("payload", '{checkoutRef}', to_jsonb(${selectedRef}::text), true),
        "checkoutConflictHeldAt" = NULL,
        "nextAttemptAt" = ${now}
    WHERE "merchantId" = ${merchantId}
      AND "payload"->>'provider' = 'nowpayments'
      AND "payload"->>'sourceOrderId' = ${sourceOrderId}
      AND "payload"->>'paymentRef' = ${selectedPaymentRef}
      AND "payload"->>'status' = ${finalStatus}
      AND "status" = 'PENDING'::"CommerceEventDeliveryStatus"
      AND attempts = 0
      AND "checkoutConflictHeldAt" IS NOT NULL
  `;

  // Stale, attempted, or in-flight events are retained as evidence but never
  // retried under an event ID whose body may already have been observed.
  await tx.$executeRaw`
    UPDATE "CommerceEventDelivery"
    SET "status" = 'FAILED'::"CommerceEventDeliveryStatus",
        "checkoutConflictHeldAt" = NULL,
        "lastError" = COALESCE("lastError", 'Superseded by the reconciled terminal payment status.'),
        "nextAttemptAt" = ${now}
    WHERE "merchantId" = ${merchantId}
      AND "payload"->>'provider' = 'nowpayments'
      AND "payload"->>'sourceOrderId' = ${sourceOrderId}
      AND "payload"->>'paymentRef' = ${selectedPaymentRef}
      AND "payload"->>'status' IN ('finished', 'refunded')
      AND "checkoutConflictHeldAt" IS NOT NULL
      AND (
        "status" = 'PROCESSING'::"CommerceEventDeliveryStatus"
        OR "status" = 'FAILED'::"CommerceEventDeliveryStatus"
        OR ("status" = 'PENDING'::"CommerceEventDeliveryStatus" AND attempts > 0)
        OR ("status" = 'PENDING'::"CommerceEventDeliveryStatus" AND attempts = 0 AND "payload"->>'status' <> ${finalStatus})
      )
  `;

  // Retire held events for a losing payment without changing their body or ID.
  // If one may already have reached the receiver, the selected payment notice
  // below carries the correction under its own payment-scoped event ID.
  await tx.$executeRaw`
    UPDATE "CommerceEventDelivery"
    SET "status" = 'FAILED'::"CommerceEventDeliveryStatus",
        "checkoutConflictHeldAt" = NULL,
        "lastError" = COALESCE("lastError", 'Superseded by the owner-selected provider payment.'),
        "nextAttemptAt" = ${now}
    WHERE "merchantId" = ${merchantId}
      AND "payload"->>'provider' = 'nowpayments'
      AND "payload"->>'sourceOrderId' = ${sourceOrderId}
      AND "payload"->>'paymentRef' IS NOT NULL
      AND "payload"->>'paymentRef' <> ${selectedPaymentRef}
      AND "payload"->>'status' IN ('finished', 'refunded')
      AND "checkoutConflictHeldAt" IS NOT NULL
      AND "status" IN (
        'PENDING'::"CommerceEventDeliveryStatus",
        'PROCESSING'::"CommerceEventDeliveryStatus",
        'FAILED'::"CommerceEventDeliveryStatus"
      )
  `;

  const exposure = await tx.$queryRaw<{
    deliveredTerminal: boolean;
    uncertainTerminal: boolean;
    supersededExposure: boolean;
    conflictNoticeExists: boolean;
    paymentRef: string | null;
  }[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM "CommerceEventDelivery"
        WHERE "merchantId" = ${merchantId}
          AND "payload"->>'provider' = 'nowpayments'
          AND "payload"->>'sourceOrderId' = ${sourceOrderId}
          AND "payload"->>'paymentRef' = ${selectedPaymentRef}
          AND "payload"->>'status' IN ('finished', 'refunded')
          AND "status" = 'DELIVERED'::"CommerceEventDeliveryStatus"
      ) AS "deliveredTerminal",
      EXISTS (
        SELECT 1 FROM "CommerceEventDelivery"
        WHERE "merchantId" = ${merchantId}
          AND "payload"->>'provider' = 'nowpayments'
          AND "payload"->>'sourceOrderId' = ${sourceOrderId}
          AND "payload"->>'paymentRef' = ${selectedPaymentRef}
          AND "payload"->>'status' IN ('finished', 'refunded')
          AND (
            "status" = 'PROCESSING'::"CommerceEventDeliveryStatus"
            OR ("status" = 'FAILED'::"CommerceEventDeliveryStatus" AND attempts > 0)
            OR ("status" = 'PENDING'::"CommerceEventDeliveryStatus" AND attempts > 0)
          )
      ) AS "uncertainTerminal",
      EXISTS (
        SELECT 1 FROM "CommerceEventDelivery"
        WHERE "merchantId" = ${merchantId}
          AND "payload"->>'provider' = 'nowpayments'
          AND "payload"->>'sourceOrderId' = ${sourceOrderId}
          AND "payload"->>'paymentRef' <> ${selectedPaymentRef}
          AND "payload"->>'status' IN ('finished', 'refunded')
          AND (
            "status" = 'DELIVERED'::"CommerceEventDeliveryStatus"
            OR "status" = 'PROCESSING'::"CommerceEventDeliveryStatus"
            OR ("status" = 'FAILED'::"CommerceEventDeliveryStatus" AND attempts > 0)
            OR ("status" = 'PENDING'::"CommerceEventDeliveryStatus" AND attempts > 0)
          )
      ) AS "supersededExposure",
      EXISTS (
        SELECT 1 FROM "CommerceEventDelivery"
        WHERE "merchantId" = ${merchantId}
          AND "payload"->>'provider' = 'nowpayments'
          AND "payload"->>'sourceOrderId' = ${sourceOrderId}
          AND "payload"->>'status' = 'invoice_conflict'
          AND (
            "status" IN (
              'PENDING'::"CommerceEventDeliveryStatus",
              'PROCESSING'::"CommerceEventDeliveryStatus",
              'DELIVERED'::"CommerceEventDeliveryStatus"
            )
            OR ("status" = 'FAILED'::"CommerceEventDeliveryStatus" AND attempts > 0)
          )
      ) AS "conflictNoticeExists",
      (
        SELECT "payload"->>'paymentRef' FROM "CommerceEventDelivery"
        WHERE "merchantId" = ${merchantId}
          AND "payload"->>'provider' = 'nowpayments'
          AND "payload"->>'sourceOrderId' = ${sourceOrderId}
          AND "payload"->>'paymentRef' = ${selectedPaymentRef}
          AND "payload"->>'status' IN ('finished', 'refunded')
        ORDER BY "createdAt" DESC LIMIT 1
      ) AS "paymentRef"
  `;
  const state = exposure[0];
  if (state && (
    state.deliveredTerminal ||
    state.uncertainTerminal ||
    state.supersededExposure ||
    state.conflictNoticeExists
  )) {
    await enqueueReferenceNotice(tx, {
      merchantId,
      sourceOrderId,
      paymentRef: noticePaymentRef ?? state.paymentRef,
      status: "invoice_reconciled",
      primaryRef: selectedRef,
      alternateRef: null,
      selectedRef,
      payment: noticePayment,
    });
  }
}

/** Record a provider invoice reference without discarding any existing reference. */
export async function recordCommerceCheckoutReference(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  providerRef: string,
  forceUncertain = false
): Promise<{ matchesPrimary: boolean; hasConflict: boolean }> {
  const rows = await tx.$queryRaw<CheckoutReferenceRow[]>`
    SELECT "merchantId", "sourceOrderId", "status", "hostedCheckoutRef", "alternateCheckoutRef"
    FROM "CommerceCheckout"
    WHERE "id" = ${checkoutId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return { matchesPrimary: false, hasConflict: true };

  const { hostedCheckoutRef: primaryRef, alternateCheckoutRef: alternateRef } = row;
  const hasConflict = Boolean(alternateRef || (primaryRef && primaryRef !== providerRef));
  const shouldBecomeUncertain = Boolean(
    hasConflict ||
    !primaryRef ||
    forceUncertain ||
    ["CREATING", "UNCERTAIN", "RETRYABLE"].includes(row.status)
  );
  const data: Prisma.CommerceCheckoutUpdateManyMutationInput = {};

  if (!primaryRef) data.hostedCheckoutRef = providerRef;
  else if (primaryRef !== providerRef && !alternateRef) data.alternateCheckoutRef = providerRef;

  if (shouldBecomeUncertain) {
    data.status = "UNCERTAIN";
    data.hostedCheckoutUrl = null;
    data.lastCreationError = hasConflict ? UNRESOLVED_REFERENCE_MESSAGE : PENDING_REFERENCE_MESSAGE;
    data.nextAttemptAt = null;
  }

  if (Object.keys(data).length > 0) {
    await tx.commerceCheckout.updateMany({ where: { id: checkoutId }, data });
  }

  if (hasConflict) {
    await holdUnpaidCheckoutCommissions(tx, checkoutId);
    await holdCheckoutDeliveries(tx, row.merchantId, row.sourceOrderId);
    const delivered = await tx.$queryRaw<{ paymentRef: string | null }[]>`
      SELECT "payload"->>'paymentRef' AS "paymentRef"
      FROM "CommerceEventDelivery"
      WHERE "merchantId" = ${row.merchantId}
        AND "payload"->>'provider' = 'nowpayments'
        AND "payload"->>'sourceOrderId' = ${row.sourceOrderId}
        AND "payload"->>'status' IN ('finished', 'refunded')
        AND "status" = 'DELIVERED'::"CommerceEventDeliveryStatus"
      LIMIT 1
    `;
    if (delivered.length > 0) {
      await enqueueReferenceNotice(tx, {
        merchantId: row.merchantId,
        sourceOrderId: row.sourceOrderId,
        paymentRef: delivered[0].paymentRef,
        status: "invoice_conflict",
        primaryRef,
        alternateRef: alternateRef ?? (primaryRef !== providerRef ? providerRef : null),
        selectedRef: null,
        conflictingRefs: [providerRef],
      });
    }
  }

  return {
    matchesPrimary: (!primaryRef || primaryRef === providerRef) && !alternateRef,
    hasConflict,
  };
}
