import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import {
  COMMISSION_STATUS,
  UNPAID_COMMISSION_STATUSES,
} from "@/lib/commissionStatus";
import { SqlSchema } from "@/lib/sqlSchema";
import {
  lockPayoutEligibilityGroup,
  lockPayoutEligibilityProgram,
  recalculatePayoutEligibility,
  type PayoutEligibilityGroup,
} from "@/lib/payoutEligibility";

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

async function checkoutPayoutGroups(
  tx: Prisma.TransactionClient,
  checkoutId: string,
): Promise<PayoutEligibilityGroup[]> {
  const rows = await tx.commission.findMany({
    where: {
      paymentRecord: { is: { checkoutId } },
      status: { in: [...UNPAID_COMMISSION_STATUSES] },
      programId: { not: null },
      merchantId: { not: null },
    },
    distinct: ["merchantId", "affiliateId", "programId", "currency"],
    select: {
      merchantId: true,
      affiliateId: true,
      programId: true,
      currency: true,
    },
  });
  return rows
    .filter((row) => row.merchantId && row.programId)
    .map((row) => ({
      merchantId: row.merchantId!,
      affiliateId: row.affiliateId,
      programId: row.programId!,
      currency: row.currency,
    }))
    .sort((a, b) =>
      `${a.merchantId}:${a.programId}:${a.affiliateId}:${a.currency}`.localeCompare(
        `${b.merchantId}:${b.programId}:${b.affiliateId}:${b.currency}`,
      ),
    );
}

async function lockPayoutGroups(
  tx: Prisma.TransactionClient,
  groups: PayoutEligibilityGroup[],
): Promise<void> {
  for (const group of groups) {
    if (!(await lockPayoutEligibilityProgram(tx, group.merchantId, group.programId))) {
      continue;
    }
    await lockPayoutEligibilityGroup(tx, group);
  }
}

async function recalculatePayoutGroups(
  tx: Prisma.TransactionClient,
  groups: PayoutEligibilityGroup[],
  now: Date,
): Promise<void> {
  for (const group of groups) {
    await recalculatePayoutEligibility(tx, group, now);
  }
}

export async function holdUnpaidCheckoutCommissions(
  tx: Prisma.TransactionClient,
  checkoutId: string,
): Promise<void> {
  const groups = await checkoutPayoutGroups(tx, checkoutId);
  await lockPayoutGroups(tx, groups);
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.Commission.name} AS commission
    SET ${SqlSchema.tables.Commission.checkoutConflictHeldAt} = COALESCE(commission.${SqlSchema.tables.Commission.checkoutConflictHeldAt}, now()),
        ${SqlSchema.tables.Commission.status} = CASE
          WHEN commission.${SqlSchema.tables.Commission.status} = ${COMMISSION_STATUS.PAYABLE}::${SqlSchema.types.CommissionStatus} THEN ${COMMISSION_STATUS.PENDING}::${SqlSchema.types.CommissionStatus}
          ELSE commission.${SqlSchema.tables.Commission.status}
        END
    FROM ${SqlSchema.tables.PaymentRecord.name} AS payment
    WHERE payment.${SqlSchema.tables.PaymentRecord.checkoutId} = ${checkoutId}
      AND payment.${SqlSchema.tables.PaymentRecord.id} = commission.${SqlSchema.tables.Commission.paymentRecordId}
      AND commission.${SqlSchema.tables.Commission.status} IN (
        ${COMMISSION_STATUS.PENDING}::${SqlSchema.types.CommissionStatus},
        ${COMMISSION_STATUS.PAYABLE}::${SqlSchema.types.CommissionStatus},
        ${COMMISSION_STATUS.FLAGGED}::${SqlSchema.types.CommissionStatus}
      )
  `);
  await recalculatePayoutGroups(tx, groups, new Date());
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
  const groups = await checkoutPayoutGroups(tx, checkoutId);
  await lockPayoutGroups(tx, groups);
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
          AND commission.${SqlSchema.tables.Commission.status} = ${COMMISSION_STATUS.VOIDED}::${SqlSchema.types.CommissionStatus}
      `);
    } else {
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
          AND commission.${SqlSchema.tables.Commission.status} IN (
            ${COMMISSION_STATUS.PENDING}::${SqlSchema.types.CommissionStatus},
            ${COMMISSION_STATUS.PAYABLE}::${SqlSchema.types.CommissionStatus},
            ${COMMISSION_STATUS.FLAGGED}::${SqlSchema.types.CommissionStatus},
            ${COMMISSION_STATUS.VOIDED}::${SqlSchema.types.CommissionStatus}
          )
      `);
    }
  }
  await recalculatePayoutGroups(tx, groups, now);
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
