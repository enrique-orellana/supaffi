import { PaymentProvider } from "@/lib/payments/types";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { enqueueCommerceEvent } from "@/lib/commerceOutbox";
import { SqlSchema } from "@/lib/sqlSchema";

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
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.Commission.name} AS commission
    SET ${SqlSchema.tables.Commission.checkoutConflictHeldAt} = COALESCE(commission.${SqlSchema.tables.Commission.checkoutConflictHeldAt}, now()),
        ${SqlSchema.tables.Commission.status} = CASE
          WHEN commission.${SqlSchema.tables.Commission.status} = 'PAYABLE'::${SqlSchema.types.CommissionStatus} THEN 'PENDING'::${SqlSchema.types.CommissionStatus}
          ELSE commission.${SqlSchema.tables.Commission.status}
        END
    FROM ${SqlSchema.tables.PaymentRecord.name} AS payment
    WHERE payment.${SqlSchema.tables.PaymentRecord.checkoutId} = ${checkoutId}
      AND payment.${SqlSchema.tables.PaymentRecord.id} = commission.${SqlSchema.tables.Commission.paymentRecordId}
      AND commission.${SqlSchema.tables.Commission.status} IN (
        'PENDING'::${SqlSchema.types.CommissionStatus},
        'PAYABLE'::${SqlSchema.types.CommissionStatus},
        'FLAGGED'::${SqlSchema.types.CommissionStatus}
      )
  `);
}

export async function holdCheckoutDeliveries(
  tx: Prisma.TransactionClient,
  merchantId: string,
  sourceOrderId: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name}
    SET ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} = COALESCE(${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt}, now())
    WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
      AND ${SqlSchema.tables.CommerceEventDelivery.status} IN (
        'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus},
        'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus},
        'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus}
      )
  `);
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
      provider: PaymentProvider.NOWPAYMENTS.id,
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
    where: { merchantId_provider_sourceOrderId: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database, sourceOrderId } },
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
      await tx.$executeRaw(Prisma.sql`
        UPDATE ${SqlSchema.tables.Commission.name} AS commission
        SET ${SqlSchema.tables.Commission.checkoutConflictHeldAt} = NULL
        FROM ${SqlSchema.tables.PaymentRecord.name} AS payment
        WHERE payment.${SqlSchema.tables.PaymentRecord.checkoutId} = ${checkoutId}
          AND payment.${SqlSchema.tables.PaymentRecord.id} = ${payment.id}
          AND payment.${SqlSchema.tables.PaymentRecord.paymentRef} = ${selectedPaymentRef}
          AND payment.${SqlSchema.tables.PaymentRecord.checkoutRef} = ${selectedRef}
          AND payment.${SqlSchema.tables.PaymentRecord.id} = commission.${SqlSchema.tables.Commission.paymentRecordId}
          AND commission.${SqlSchema.tables.Commission.checkoutConflictHeldAt} IS NOT NULL
          AND commission.${SqlSchema.tables.Commission.status} = 'VOIDED'::${SqlSchema.types.CommissionStatus}
      `);
    } else {
      await tx.$executeRaw(Prisma.sql`
        UPDATE ${SqlSchema.tables.Commission.name} AS commission
        SET ${SqlSchema.tables.Commission.checkoutConflictHeldAt} = NULL,
            ${SqlSchema.tables.Commission.status} = CASE
              WHEN commission.${SqlSchema.tables.Commission.status} = 'PENDING'::${SqlSchema.types.CommissionStatus}
                AND commission.${SqlSchema.tables.Commission.payableAt} <= ${now}
                AND commission.${SqlSchema.tables.Commission.disputeOpenedAt} IS NULL
                THEN 'PAYABLE'::${SqlSchema.types.CommissionStatus}
              ELSE commission.${SqlSchema.tables.Commission.status}
            END
        FROM ${SqlSchema.tables.PaymentRecord.name} AS payment
        WHERE payment.${SqlSchema.tables.PaymentRecord.checkoutId} = ${checkoutId}
          AND payment.${SqlSchema.tables.PaymentRecord.id} = ${payment.id}
          AND payment.${SqlSchema.tables.PaymentRecord.paymentRef} = ${selectedPaymentRef}
          AND payment.${SqlSchema.tables.PaymentRecord.checkoutRef} = ${selectedRef}
          AND payment.${SqlSchema.tables.PaymentRecord.id} = commission.${SqlSchema.tables.Commission.paymentRecordId}
          AND commission.${SqlSchema.tables.Commission.checkoutConflictHeldAt} IS NOT NULL
          AND commission.${SqlSchema.tables.Commission.status} IN (
            'PENDING'::${SqlSchema.types.CommissionStatus},
            'PAYABLE'::${SqlSchema.types.CommissionStatus},
            'FLAGGED'::${SqlSchema.types.CommissionStatus},
            'VOIDED'::${SqlSchema.types.CommissionStatus}
          )
      `);
    }
  }

  // A body is immutable once a request may have reached the receiver. Only
  // never-attempted terminal events can be linked and released in place.
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name}
    SET ${SqlSchema.tables.CommerceEventDelivery.payload} = jsonb_set(${SqlSchema.tables.CommerceEventDelivery.payload}, '{checkoutRef}', to_jsonb(${selectedRef}::text), true),
        ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} = NULL,
        ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} = ${now}
    WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' = ${selectedPaymentRef}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' = ${finalStatus}
      AND ${SqlSchema.tables.CommerceEventDelivery.status} = 'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus}
      AND ${SqlSchema.tables.CommerceEventDelivery.attempts} = 0
      AND ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} IS NOT NULL
  `);

  // Stale, attempted, or in-flight events are retained as evidence but never
  // retried under an event ID whose body may already have been observed.
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name}
    SET ${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus},
        ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} = NULL,
        ${SqlSchema.tables.CommerceEventDelivery.lastError} = COALESCE(${SqlSchema.tables.CommerceEventDelivery.lastError}, 'Superseded by the reconciled terminal payment status.'),
        ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} = ${now}
    WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' = ${selectedPaymentRef}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
      AND ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} IS NOT NULL
      AND (
        ${SqlSchema.tables.CommerceEventDelivery.status} = 'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus}
        OR ${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus}
        OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
        OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} = 0 AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' <> ${finalStatus})
      )
  `);

  // Retire held events for a losing payment without changing their body or ID.
  // If one may already have reached the receiver, the selected payment notice
  // below carries the correction under its own payment-scoped event ID.
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.CommerceEventDelivery.name}
    SET ${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus},
        ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} = NULL,
        ${SqlSchema.tables.CommerceEventDelivery.lastError} = COALESCE(${SqlSchema.tables.CommerceEventDelivery.lastError}, 'Superseded by the owner-selected provider payment.'),
        ${SqlSchema.tables.CommerceEventDelivery.nextAttemptAt} = ${now}
    WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' IS NOT NULL
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' <> ${selectedPaymentRef}
      AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
      AND ${SqlSchema.tables.CommerceEventDelivery.checkoutConflictHeldAt} IS NOT NULL
      AND ${SqlSchema.tables.CommerceEventDelivery.status} IN (
        'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus},
        'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus},
        'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus}
      )
  `);

  const exposure = await tx.$queryRaw<{
    deliveredTerminal: boolean;
    uncertainTerminal: boolean;
    supersededExposure: boolean;
    conflictNoticeExists: boolean;
    paymentRef: string | null;
  }[]>(Prisma.sql`
    SELECT
      EXISTS (
        SELECT 1 FROM ${SqlSchema.tables.CommerceEventDelivery.name}
        WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' = ${selectedPaymentRef}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
          AND ${SqlSchema.tables.CommerceEventDelivery.status} = 'DELIVERED'::${SqlSchema.types.CommerceEventDeliveryStatus}
      ) AS "deliveredTerminal",
      EXISTS (
        SELECT 1 FROM ${SqlSchema.tables.CommerceEventDelivery.name}
        WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' = ${selectedPaymentRef}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
          AND (
            ${SqlSchema.tables.CommerceEventDelivery.status} = 'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus}
            OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
            OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
          )
      ) AS "uncertainTerminal",
      EXISTS (
        SELECT 1 FROM ${SqlSchema.tables.CommerceEventDelivery.name}
        WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' <> ${selectedPaymentRef}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
          AND (
            ${SqlSchema.tables.CommerceEventDelivery.status} = 'DELIVERED'::${SqlSchema.types.CommerceEventDeliveryStatus}
            OR ${SqlSchema.tables.CommerceEventDelivery.status} = 'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus}
            OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
            OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
          )
      ) AS "supersededExposure",
      EXISTS (
        SELECT 1 FROM ${SqlSchema.tables.CommerceEventDelivery.name}
        WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' = 'invoice_conflict'
          AND (
            ${SqlSchema.tables.CommerceEventDelivery.status} IN (
              'PENDING'::${SqlSchema.types.CommerceEventDeliveryStatus},
              'PROCESSING'::${SqlSchema.types.CommerceEventDeliveryStatus},
              'DELIVERED'::${SqlSchema.types.CommerceEventDeliveryStatus}
            )
            OR (${SqlSchema.tables.CommerceEventDelivery.status} = 'FAILED'::${SqlSchema.types.CommerceEventDeliveryStatus} AND ${SqlSchema.tables.CommerceEventDelivery.attempts} > 0)
          )
      ) AS "conflictNoticeExists",
      (
        SELECT ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef'
        FROM ${SqlSchema.tables.CommerceEventDelivery.name}
        WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${merchantId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${sourceOrderId}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' = ${selectedPaymentRef}
          AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
        ORDER BY ${SqlSchema.tables.CommerceEventDelivery.createdAt} DESC LIMIT 1
      ) AS "paymentRef"
  `);
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
  const rows = await tx.$queryRaw<CheckoutReferenceRow[]>(Prisma.sql`
    SELECT
      ${SqlSchema.tables.CommerceCheckout.merchantId},
      ${SqlSchema.tables.CommerceCheckout.sourceOrderId},
      ${SqlSchema.tables.CommerceCheckout.status},
      ${SqlSchema.tables.CommerceCheckout.hostedCheckoutRef},
      ${SqlSchema.tables.CommerceCheckout.alternateCheckoutRef}
    FROM ${SqlSchema.tables.CommerceCheckout.name}
    WHERE ${SqlSchema.tables.CommerceCheckout.id} = ${checkoutId}
    FOR UPDATE
  `);
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
    const delivered = await tx.$queryRaw<{ paymentRef: string | null }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.CommerceEventDelivery.payload}->>'paymentRef' AS "paymentRef"
      FROM ${SqlSchema.tables.CommerceEventDelivery.name}
      WHERE ${SqlSchema.tables.CommerceEventDelivery.merchantId} = ${row.merchantId}
        AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
        AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'sourceOrderId' = ${row.sourceOrderId}
        AND ${SqlSchema.tables.CommerceEventDelivery.payload}->>'status' IN ('finished', 'refunded')
        AND ${SqlSchema.tables.CommerceEventDelivery.status} = 'DELIVERED'::${SqlSchema.types.CommerceEventDeliveryStatus}
      LIMIT 1
    `);
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
