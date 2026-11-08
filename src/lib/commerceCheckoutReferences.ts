import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { SqlSchema } from "@/lib/sqlSchema";

type CheckoutReferenceRow = {
  merchantId: string;
  sourceOrderId: string;
  status: string;
  hostedCheckoutRef: string | null;
  alternateCheckoutRef: string | null;
};

const UNRESOLVED_REFERENCE_MESSAGE =
  "Multiple provider invoice references require reconciliation";
const PENDING_REFERENCE_MESSAGE =
  "Provider invoice reference received before checkout creation settled";

export async function holdUnpaidCheckoutCommissions(
  tx: Prisma.TransactionClient,
  checkoutId: string,
): Promise<void> {
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
  },
): Promise<void> {
  const now = new Date();
  const checkout = await tx.commerceCheckout.findUnique({
    where: { id: checkoutId },
    select: { refundReconciliationPendingAt: true },
  });
  if (!checkout) return;
  if (
    checkout.refundReconciliationPendingAt &&
    appliedTerminalStatus !== "refunded"
  )
    return;

  const payment = await tx.paymentRecord.findUnique({
    where: {
      merchantId_provider_sourceOrderId: {
        merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        sourceOrderId,
      },
    },
    select: {
      id: true,
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
    payment.checkoutRef === selectedRef,
  );
  const paymentMatchesSelectedPayment = Boolean(
    paymentMatchesSelectedInvoice &&
    payment?.paymentRef === terminalSnapshot.paymentRef,
  );
  if (!payment || !paymentMatchesSelectedPayment) return;
  if (
    !["finished", "refunded"].includes(terminalSnapshot.status) ||
    terminalSnapshot.status !== appliedTerminalStatus ||
    (terminalSnapshot.invoiceRef !== null &&
      terminalSnapshot.invoiceRef !== selectedRef)
  )
    return;
  const storedPaymentStatus = payment.status.toLowerCase();
  if (!["finished", "refunded"].includes(storedPaymentStatus)) return;
  const finalStatus = appliedTerminalStatus;
  if (appliedTerminalStatus && storedPaymentStatus !== appliedTerminalStatus)
    return;
  const selectedPaymentRef = payment.paymentRef;
  if (appliedTerminalStatus === "refunded") {
    await tx.commerceCheckout.updateMany({
      where: { id: checkoutId, refundReconciliationPendingAt: { not: null } },
      data: { refundReconciliationPendingAt: null },
    });
  }
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
}

/** Record a provider invoice reference without discarding any existing reference. */
export async function recordCommerceCheckoutReference(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  providerRef: string,
  forceUncertain = false,
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

  const { hostedCheckoutRef: primaryRef, alternateCheckoutRef: alternateRef } =
    row;
  const hasConflict = Boolean(
    alternateRef || (primaryRef && primaryRef !== providerRef),
  );
  const shouldBecomeUncertain = Boolean(
    hasConflict ||
    !primaryRef ||
    forceUncertain ||
    ["CREATING", "UNCERTAIN", "RETRYABLE"].includes(row.status),
  );
  const data: Prisma.CommerceCheckoutUpdateManyMutationInput = {};

  if (!primaryRef) data.hostedCheckoutRef = providerRef;
  else if (primaryRef !== providerRef && !alternateRef)
    data.alternateCheckoutRef = providerRef;

  if (shouldBecomeUncertain) {
    data.status = "UNCERTAIN";
    data.hostedCheckoutUrl = null;
    data.lastCreationError = hasConflict
      ? UNRESOLVED_REFERENCE_MESSAGE
      : PENDING_REFERENCE_MESSAGE;
    data.nextAttemptAt = null;
  }

  if (Object.keys(data).length > 0) {
    await tx.commerceCheckout.updateMany({ where: { id: checkoutId }, data });
  }

  if (hasConflict) {
    await holdUnpaidCheckoutCommissions(tx, checkoutId);
  }

  return {
    matchesPrimary:
      (!primaryRef || primaryRef === providerRef) && !alternateRef,
    hasConflict,
  };
}
