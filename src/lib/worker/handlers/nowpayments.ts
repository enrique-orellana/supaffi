import { PaymentProvider } from "@/lib/payments/types";
import { createHash } from "node:crypto";
import { Prisma, ProviderFeeSource } from "@prisma/client";
import {
  clickNeedsCurrentTermFallback,
  resolveClickCommissionTerms,
} from "@/lib/commissionTerms";
import type {
  CommerceCheckout,
  PaymentRecord,
  WebhookEvent,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  COMMISSION_STATUS,
  UNPAID_COMMISSION_STATUSES,
} from "@/lib/commissionStatus";
import { NOWPAYMENTS_PAYMENT_STATUS } from "@/lib/payments/providers/nowpayments";
import { SqlSchema } from "@/lib/sqlSchema";
import {
  recordCommerceCheckoutReference,
  releaseCheckoutConflictHold,
} from "@/lib/commerceCheckoutReferences";
import {
  lockCommissionPayoutEligibilityGroup,
  recalculatePayoutEligibility,
} from "@/lib/payoutEligibility";
import { computePayableAt } from "../commission";
import {
  commissionAfterProviderFee,
  nowPaymentsFeeMinorInCurrency,
  resolveProviderFee,
  type ResolvedProviderFee,
} from "../providerFees";
import { currencyMinorUnitExponent } from "@/lib/currency";
import { referralStillEarns } from "../referralDuration";

type JsonObject = Record<string, unknown>;

type QueuedNowPaymentsEvent = {
  provider: typeof PaymentProvider.NOWPAYMENTS.id;
  eventId: string;
  kind:
    | "payment_succeeded"
    | "payment_failed"
    | "payment_refunded"
    | "payment_pending";
  paymentRef: string;
  checkoutRef: string | null;
  saleAmount: string;
  saleCurrency: string;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  occurredAt: Date;
  sourceOrderId: string;
  providerInvoiceRef: string | null;
  providerStatus: string;
  cryptoNetwork: string | null;
  rawPayload: JsonObject;
};

const PAYMENT_STATUS_PRIORITY: Readonly<Record<string, number>> = {
  [NOWPAYMENTS_PAYMENT_STATUS.WAITING]: 0,
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING]: 1,
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED]: 2,
  [NOWPAYMENTS_PAYMENT_STATUS.PARTIALLY_PAID]: 3,
  [NOWPAYMENTS_PAYMENT_STATUS.SENDING]: 4,
  [NOWPAYMENTS_PAYMENT_STATUS.FAILED]: 5,
  [NOWPAYMENTS_PAYMENT_STATUS.EXPIRED]: 5,
  [NOWPAYMENTS_PAYMENT_STATUS.FINISHED]: 6,
  [NOWPAYMENTS_PAYMENT_STATUS.REFUNDED]: 7,
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decimalText(
  value: unknown,
  maxIntegerDigits: number,
  maxFractionDigits: number,
): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (
    !match ||
    match[1].length > maxIntegerDigits ||
    (match[2]?.length ?? 0) > maxFractionDigits
  )
    return null;
  return value;
}

function parseQueuedEvent(payload: unknown): QueuedNowPaymentsEvent | null {
  if (!isObject(payload) || payload.provider !== PaymentProvider.NOWPAYMENTS.id)
    return null;
  if (
    typeof payload.eventId !== "string" ||
    typeof payload.kind !== "string" ||
    ![
      "payment_succeeded",
      "payment_failed",
      "payment_refunded",
      "payment_pending",
    ].includes(payload.kind) ||
    typeof payload.paymentRef !== "string" ||
    !payload.paymentRef.trim() ||
    typeof payload.saleAmount !== "string" ||
    typeof payload.saleCurrency !== "string" ||
    typeof payload.occurredAt !== "string" ||
    !isObject(payload.rawPayload)
  )
    return null;

  const raw = payload.rawPayload;
  const providerStatus = raw.payment_status;
  const rawPaymentRef =
    typeof raw.payment_id === "string"
      ? raw.payment_id
      : typeof raw.payment_id === "number" &&
          Number.isSafeInteger(raw.payment_id)
        ? String(raw.payment_id)
        : null;
  const providerInvoiceRef =
    typeof raw.invoice_id === "string" && raw.invoice_id.trim()
      ? raw.invoice_id
      : typeof raw.invoice_id === "number" &&
          Number.isSafeInteger(raw.invoice_id)
        ? String(raw.invoice_id)
        : null;
  const sourceOrderId =
    typeof raw.order_id === "string" && raw.order_id.trim()
      ? raw.order_id
      : (rawPaymentRef ?? "");
  if (
    !rawPaymentRef ||
    !sourceOrderId.trim() ||
    sourceOrderId.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(sourceOrderId) ||
    typeof providerStatus !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      PAYMENT_STATUS_PRIORITY,
      providerStatus,
    ) ||
    rawPaymentRef !== payload.paymentRef ||
    (payload.eventId !== `${payload.paymentRef}:${providerStatus}` &&
      !(
        payload.reconciliation === true &&
        /^owner-reconcile:[a-f0-9]{64}$/.test(payload.eventId)
      ))
  )
    return null;

  const saleAmount = decimalText(payload.saleAmount, 16, 2);
  const saleCurrency = payload.saleCurrency.toLowerCase();
  const occurredAt = new Date(payload.occurredAt);
  if (
    !saleAmount ||
    !/^[a-z]{3}$/.test(saleCurrency) ||
    Number.isNaN(occurredAt.getTime())
  )
    return null;

  const cryptoAmount = decimalText(payload.cryptoAmount, 20, 18);
  const cryptoCurrency =
    typeof payload.cryptoCurrency === "string" &&
    /^[a-z0-9_-]{2,20}$/i.test(payload.cryptoCurrency)
      ? payload.cryptoCurrency.toLowerCase()
      : null;
  const cryptoNetwork =
    typeof raw.network === "string" && /^[a-z0-9_-]{1,40}$/i.test(raw.network)
      ? raw.network.toLowerCase()
      : null;

  return {
    provider: PaymentProvider.NOWPAYMENTS.id,
    eventId: payload.eventId,
    kind: payload.kind as QueuedNowPaymentsEvent["kind"],
    paymentRef: payload.paymentRef,
    checkoutRef:
      typeof payload.checkoutRef === "string" ? payload.checkoutRef : null,
    saleAmount,
    saleCurrency,
    cryptoAmount,
    cryptoCurrency,
    occurredAt,
    sourceOrderId,
    providerInvoiceRef,
    providerStatus,
    cryptoNetwork,
    rawPayload: raw,
  };
}

/** Prefer the provider update time, then its creation time, when available. */
function providerTimestamp(event: QueuedNowPaymentsEvent): Date | null {
  for (const value of [
    event.rawPayload.updated_at,
    event.rawPayload.created_at,
  ]) {
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

async function lockNowPaymentsReference(
  tx: Prisma.TransactionClient,
  merchantId: string,
  kind: "payment" | "invoice" | "order",
  reference: string,
): Promise<void> {
  const lockSeed = `${merchantId}\0${kind}\0${reference}`;
  const lockBytes = createHash("sha256").update(lockSeed, "utf8").digest();
  await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_advisory_xact_lock(${lockBytes.readInt32BE(0)}::integer, ${lockBytes.readInt32BE(4)}::integer) IS NULL AS locked
  `;
}

function statusAfter(current: string | null, incoming: string): string {
  if (!current) return incoming;
  const prior = current.toLowerCase();
  const priorPriority = PAYMENT_STATUS_PRIORITY[prior] ?? -1;
  const incomingPriority = PAYMENT_STATUS_PRIORITY[incoming] ?? -1;
  if (
    prior === NOWPAYMENTS_PAYMENT_STATUS.REFUNDED ||
    incoming === NOWPAYMENTS_PAYMENT_STATUS.REFUNDED
  )
    return NOWPAYMENTS_PAYMENT_STATUS.REFUNDED;
  if (
    prior === NOWPAYMENTS_PAYMENT_STATUS.FINISHED ||
    incoming === NOWPAYMENTS_PAYMENT_STATUS.FINISHED
  )
    return NOWPAYMENTS_PAYMENT_STATUS.FINISHED;
  if (
    (prior === NOWPAYMENTS_PAYMENT_STATUS.FAILED ||
      prior === NOWPAYMENTS_PAYMENT_STATUS.EXPIRED) &&
    incomingPriority < 5
  )
    return prior;
  if (
    (incoming === NOWPAYMENTS_PAYMENT_STATUS.FAILED ||
      incoming === NOWPAYMENTS_PAYMENT_STATUS.EXPIRED) &&
    priorPriority < 5
  )
    return incoming;
  return incomingPriority >= priorPriority ? incoming : prior;
}

function paymentTerminalSnapshot(
  event: QueuedNowPaymentsEvent,
  paymentRecord: PaymentRecord,
): {
  paymentRef: string;
  invoiceRef: string | null;
  status: string;
  saleAmount: string;
  saleCurrency: string;
  cryptoAmount: string | null;
  cryptoCurrency: string | null;
  cryptoNetwork: string | null;
} {
  return {
    paymentRef: event.paymentRef,
    invoiceRef: event.providerInvoiceRef,
    status: paymentRecord.status.toLowerCase(),
    saleAmount: paymentRecord.saleAmount.toString(),
    saleCurrency: paymentRecord.saleCurrency,
    cryptoAmount: paymentRecord.cryptoAmount?.toString() ?? null,
    cryptoCurrency: paymentRecord.cryptoCurrency,
    cryptoNetwork: paymentRecord.cryptoNetwork,
  };
}

async function findExistingPaymentRecord(
  tx: Prisma.TransactionClient,
  input: { merchantId: string; sourceOrderId: string; paymentRef: string },
): Promise<PaymentRecord | null> {
  const byPaymentId = await tx.paymentRecord.findUnique({
    where: {
      merchantId_provider_paymentRef: {
        merchantId: input.merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        paymentRef: input.paymentRef,
      },
    },
  });
  if (byPaymentId) return byPaymentId;

  return tx.paymentRecord.findUnique({
    where: {
      merchantId_provider_sourceOrderId: {
        merchantId: input.merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        sourceOrderId: input.sourceOrderId,
      },
    },
  });
}

async function upsertPaymentRecord(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    connectionId: string;
    checkoutId: string | null;
    clickId: string | null;
    sourceOrderId: string;
    paymentRef: string;
    checkoutRef: string | null;
    saleAmount: Prisma.Decimal;
    saleCurrency: string;
    cryptoAmount: Prisma.Decimal | null;
    cryptoCurrency: string | null;
    cryptoNetwork: string | null;
    status: string;
    providerFee: ResolvedProviderFee | null | undefined;
  },
): Promise<PaymentRecord> {
  const existing = await findExistingPaymentRecord(tx, {
    merchantId: input.merchantId,
    sourceOrderId: input.sourceOrderId,
    paymentRef: input.paymentRef,
  });
  const samePayment = existing?.paymentRef === input.paymentRef;
  const status = samePayment
    ? statusAfter(existing?.status ?? null, input.status)
    : input.status;
  const cryptoAmount =
    samePayment && existing?.cryptoAmount && input.cryptoAmount
      ? existing.cryptoAmount.gte(input.cryptoAmount)
        ? existing.cryptoAmount
        : input.cryptoAmount
      : samePayment
        ? (input.cryptoAmount ?? existing?.cryptoAmount ?? null)
        : input.cryptoAmount;
  const checkoutRef = samePayment
    ? (input.checkoutRef ?? existing?.checkoutRef ?? null)
    : input.checkoutRef;

  const record = existing
    ? await tx.paymentRecord.update({
        where: { id: existing.id },
        data: {
          connectionId: input.connectionId,
          checkoutId: input.checkoutId ?? existing.checkoutId,
          clickId: input.clickId ?? existing.clickId,
          paymentRef: input.paymentRef,
          checkoutRef,
          saleAmount: input.saleAmount,
          saleCurrency: input.saleCurrency,
          cryptoAmount,
          cryptoCurrency: samePayment
            ? (input.cryptoCurrency ?? existing.cryptoCurrency)
            : input.cryptoCurrency,
          cryptoNetwork: samePayment
            ? (input.cryptoNetwork ?? existing.cryptoNetwork)
            : input.cryptoNetwork,
          ...(input.providerFee === undefined
            ? {}
            : {
                providerFeeAmount:
                  input.providerFee?.providerFeeAmount ?? null,
                providerFeeSource:
                  input.providerFee?.providerFeeSource ?? null,
              }),
          status,
        },
      })
    : await tx.paymentRecord.create({
        data: {
          merchantId: input.merchantId,
          connectionId: input.connectionId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: input.sourceOrderId,
          checkoutId: input.checkoutId,
          paymentRef: input.paymentRef,
          checkoutRef,
          saleAmount: input.saleAmount,
          saleCurrency: input.saleCurrency,
          cryptoAmount,
          cryptoCurrency: input.cryptoCurrency,
          cryptoNetwork: input.cryptoNetwork,
          providerFeeAmount:
            input.providerFee?.providerFeeAmount ?? null,
          providerFeeSource: input.providerFee?.providerFeeSource ?? null,
          status,
          clickId: input.clickId,
        },
      });

  return record;
}

async function createCommissionIfEligible(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    event: QueuedNowPaymentsEvent;
    clickId: string | null;
    paymentRecord: PaymentRecord;
    clickMatches: boolean;
    checkoutAttributionAt: Date | null;
    allowRefundVoidRestore: boolean;
  },
): Promise<void> {
  const { event } = input;
  if (!input.clickId || !input.clickMatches) return;

  const existing = await tx.commission.findUnique({
    where: { paymentRecordId: input.paymentRecord.id },
    select: {
      id: true,
      status: true,
      voidReason: true,
      paidAt: true,
      flagReason: true,
    },
  });
  // A replacement payment for the owner-selected invoice may reuse only the
  // unpaid commission voided by the prior payment's refund. PAID and other
  // VOIDED rows remain final.
  const restoreRefundVoid = Boolean(
    input.allowRefundVoidRestore &&
    existing &&
    existing.status === COMMISSION_STATUS.VOIDED &&
    existing.voidReason === "refund" &&
    existing.flagReason === null &&
    existing.paidAt === null,
  );
  if (existing && !restoreRefundVoid) return;

  const lockedClicks = await tx.$queryRaw<
    { fraudConfirmedAt: Date | null }[]
  >(Prisma.sql`
    SELECT ${SqlSchema.tables.Click.fraudConfirmedAt}
    FROM ${SqlSchema.tables.Click.name}
    WHERE ${SqlSchema.tables.Click.id} = ${input.clickId}
      AND ${SqlSchema.tables.Click.merchantId} = ${input.merchantId}
    FOR UPDATE
  `);
  const lockedClick = lockedClicks[0];
  if (!lockedClick) return;

  const click = await tx.click.findFirst({
    where: { id: input.clickId, merchantId: input.merchantId },
    include: {
      affiliate: true,
      program: true,
    },
  });
  // NOWPayments IPNs may omit created_at and updated_at. The invoice mapping
  // was saved by the browser when it observed this invoice, before the buyer
  // was sent to pay; use that capture time for the attribution window. Other
  // valid checkout paths fall back to the event's provider or receipt time.
  const attributionAt =
    providerTimestamp(event) ?? input.checkoutAttributionAt ?? event.occurredAt;
  if (
    !click ||
    attributionAt < click.createdAt ||
    attributionAt > click.expiresAt
  )
    return;

  // This provider's finished-payment path is the NOWPayments equivalent of
  // Stripe's attributed-checkout proof. Record it before commission checks:
  // fraud review or a zero commission can prevent earnings without making the
  // tracking integration itself invalid.
  await tx.merchant.updateMany({
    where: { id: input.merchantId, trackingVerifiedAt: null },
    data: { trackingVerifiedAt: new Date() },
  });
  if (lockedClick.fraudConfirmedAt !== null) return;

  const affiliateTerms = clickNeedsCurrentTermFallback(click)
    ? await tx.affiliateProgramTerms.findUnique({
        where: {
          affiliateId_programId: {
            affiliateId: click.affiliateId,
            programId: click.programId,
          },
        },
      })
    : null;
  const terms = resolveClickCommissionTerms(
    click.program,
    affiliateTerms,
    click,
  );
  const rate = terms.commissionRate;
  if (rate.lte(0)) return;

  const sale = { ref: event.paymentRef, at: attributionAt };
  if (
    !(await referralStillEarns(
      input.merchantId,
      click.id,
      click.program,
      sale,
      [],
      tx,
      terms.commissionDuration,
    ))
  )
    return;

  const saleAmount = input.paymentRecord.saleAmount;
  const saleCurrency = input.paymentRecord.saleCurrency;
  const eligibleSaleMinor = saleAmount.mul(
    10 ** currencyMinorUnitExponent(saleCurrency),
  );
  const actualFeeMinor = input.paymentRecord.providerFeeAmount?.mul(
    10 ** currencyMinorUnitExponent(saleCurrency),
  ) ?? null;
  const { amount } = commissionAfterProviderFee({
    eligibleSaleMinor,
    currency: saleCurrency,
    ratePercent: rate,
    actualFeeMinor,
    fallbackPercent: null,
  });
  if (amount.lte(0)) return;

  const commissionData = {
    affiliateId: click.affiliateId,
    merchantId: click.merchantId,
    programId: click.programId,
    clickId: click.id,
    paymentRecordId: input.paymentRecord.id,
    stripePaymentRef: null,
    amount,
    grossAmount: amount,
    currency: saleCurrency,
    saleAmount,
    status: COMMISSION_STATUS.PENDING,
    payableAt: computePayableAt(terms.holdingPeriodDays),
    paidAt: null,
    voidedAt: null,
    voidReason: null,
    flagReason: null,
    disputeOpenedAt: null,
    checkoutConflictHeldAt: null,
  };
  if (existing && restoreRefundVoid) {
    await tx.commission.update({
      where: { id: existing.id },
      data: commissionData,
    });
  } else {
    await tx.commission.create({ data: commissionData });
  }
  await recalculatePayoutEligibility(tx, {
    merchantId: click.merchantId,
    affiliateId: click.affiliateId,
    programId: click.programId,
    currency: saleCurrency,
  });
}

async function markCommissionRefunded(
  tx: Prisma.TransactionClient,
  paymentRecordId: string,
): Promise<void> {
  const commission = await tx.commission.findUnique({
    where: { paymentRecordId },
    select: { id: true },
  });
  if (!commission) return;
  const group = await lockCommissionPayoutEligibilityGroup(tx, commission.id);
  if (!group) return;
  await tx.commission.updateMany({
    where: {
      paymentRecordId,
      status: { in: [...UNPAID_COMMISSION_STATUSES] },
    },
    data: {
      status: COMMISSION_STATUS.VOIDED,
      voidedAt: new Date(),
      voidReason: "refund",
      disputeOpenedAt: null,
    },
  });
  await recalculatePayoutEligibility(tx, group);
}

/** Process a NOWPayments update after the webhook route verifies its signature. */
export async function handleNowPaymentsEvent(row: WebhookEvent): Promise<void> {
  const event = parseQueuedEvent(row.payload);
  if (!event) throw new Error("Queued NOWPayments event is invalid");

  const saleAmount = new Prisma.Decimal(event.saleAmount);
  const cryptoAmount = event.cryptoAmount
    ? new Prisma.Decimal(event.cryptoAmount)
    : null;

  await db.$transaction(async (tx) => {
    // Payment ID is the stable identity across status callbacks. Lock it first,
    // then lock the invoice and order references in a stable order so retries
    // and multiple payments for one invoice cannot race each other.
    await lockNowPaymentsReference(
      tx,
      row.merchantId,
      "payment",
      event.paymentRef,
    );
    const existingPaymentById = await tx.paymentRecord.findUnique({
      where: {
        merchantId_provider_paymentRef: {
          merchantId: row.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          paymentRef: event.paymentRef,
        },
      },
    });
    const sourceOrderId =
      existingPaymentById?.sourceOrderId ?? event.sourceOrderId;
    const providerInvoiceRef =
      existingPaymentById?.checkoutRef ?? event.providerInvoiceRef;
    if (
      existingPaymentById?.checkoutRef &&
      event.providerInvoiceRef &&
      existingPaymentById.checkoutRef !== event.providerInvoiceRef
    ) {
      console.warn(
        "[worker] NOWPayments payment ID was reported with a different invoice ID; keeping its original invoice",
      );
    }
    const secondaryLocks = [
      ...(providerInvoiceRef
        ? [{ kind: "invoice" as const, reference: providerInvoiceRef }]
        : []),
      { kind: "order" as const, reference: sourceOrderId },
    ].sort((left, right) =>
      `${left.kind}:${left.reference}`.localeCompare(
        `${right.kind}:${right.reference}`,
      ),
    );
    for (const lock of secondaryLocks) {
      await lockNowPaymentsReference(
        tx,
        row.merchantId,
        lock.kind,
        lock.reference,
      );
    }
    const existingByOrder = existingPaymentById
      ? null
      : await tx.paymentRecord.findUnique({
          where: {
            merchantId_provider_sourceOrderId: {
              merchantId: row.merchantId,
              provider: PaymentProvider.NOWPAYMENTS.database,
              sourceOrderId,
            },
          },
        });
    const existing = existingPaymentById ?? existingByOrder;

    const connection = await tx.paymentConnection.findUnique({
      where: {
        merchantId_provider: {
          merchantId: row.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
        },
      },
      select: {
        id: true,
        enabled: true,
        status: true,
        feeFallbackPercent: true,
      },
    });
    if (!connection || !connection.enabled || connection.status !== "CONNECTED")
      throw new Error(
        "NOWPayments connection is missing for the queued payment event",
      );

    const checkoutKey = await tx.commerceCheckout.findUnique({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: row.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId,
        },
      },
      select: { id: true },
    });
    const storedCheckoutAttribution = providerInvoiceRef
      ? await tx.checkoutAttribution.findUnique({
          where: {
            merchantId_provider_providerCheckoutRef: {
              merchantId: row.merchantId,
              provider: PaymentProvider.NOWPAYMENTS.database,
              providerCheckoutRef: providerInvoiceRef,
            },
          },
          select: { clickId: true, createdAt: true },
        })
      : null;
    // A public browser registration may only match a provider event if it
    // reached Supaffi before the payment update. Prefer NOWPayments' provider
    // timestamp, falling back to when Supaffi received the queued update.
    const attributionCutoff = providerTimestamp(event) ?? row.createdAt;
    const checkoutAttribution =
      storedCheckoutAttribution &&
      storedCheckoutAttribution.createdAt <= attributionCutoff
        ? storedCheckoutAttribution
        : null;
    const otherCompletedInvoicePayment = providerInvoiceRef
      ? await tx.paymentRecord.findFirst({
          where: {
            merchantId: row.merchantId,
            provider: PaymentProvider.NOWPAYMENTS.database,
            checkoutRef: providerInvoiceRef,
            paymentRef: { not: event.paymentRef },
            status: {
              in: [
                NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
                NOWPAYMENTS_PAYMENT_STATUS.REFUNDED,
              ],
            },
          },
          select: { id: true },
        })
      : null;
    const invoiceAlreadyCompleted = Boolean(otherCompletedInvoicePayment);
    if (invoiceAlreadyCompleted) {
      console.warn(
        "[worker] NOWPayments invoice already has a completed payment; later payment left unattributed",
      );
    }
    let checkout: Pick<
      CommerceCheckout,
      | "id"
      | "amount"
      | "currency"
      | "clickId"
      | "status"
      | "hostedCheckoutRef"
      | "alternateCheckoutRef"
      | "reconciliationResolution"
      | "refundReconciliationPendingAt"
    > | null = null;
    if (checkoutKey) {
      await tx.$queryRaw(Prisma.sql`
        SELECT ${SqlSchema.tables.CommerceCheckout.id}
        FROM ${SqlSchema.tables.CommerceCheckout.name}
        WHERE ${SqlSchema.tables.CommerceCheckout.id} = ${checkoutKey.id}
        FOR UPDATE
      `);
      checkout = await tx.commerceCheckout.findUnique({
        where: { id: checkoutKey.id },
        select: {
          id: true,
          amount: true,
          currency: true,
          clickId: true,
          status: true,
          hostedCheckoutRef: true,
          alternateCheckoutRef: true,
          reconciliationResolution: true,
          refundReconciliationPendingAt: true,
        },
      });
    }

    const amountMatches = Boolean(checkout && checkout.amount.eq(saleAmount));
    const currencyMatches = Boolean(
      checkout && checkout.currency.toLowerCase() === event.saleCurrency,
    );
    const invoiceMatches = Boolean(
      checkout &&
      providerInvoiceRef &&
      !checkout.alternateCheckoutRef &&
      checkout.hostedCheckoutRef &&
      checkout.hostedCheckoutRef === providerInvoiceRef,
    );
    let checkoutMatches = Boolean(
      checkout &&
      checkout.status === "READY" &&
      amountMatches &&
      currencyMatches &&
      invoiceMatches,
    );
    if (checkout && providerInvoiceRef) {
      const reference = await recordCommerceCheckoutReference(
        tx,
        checkout.id,
        providerInvoiceRef,
      );
      const refreshed = await tx.commerceCheckout.findUnique({
        where: { id: checkout.id },
        select: {
          status: true,
          hostedCheckoutRef: true,
          alternateCheckoutRef: true,
        },
      });
      checkoutMatches = Boolean(
        checkoutMatches &&
        reference.matchesPrimary &&
        refreshed?.status === "READY" &&
        refreshed.hostedCheckoutRef === providerInvoiceRef &&
        !refreshed.alternateCheckoutRef,
      );
      if (refreshed) {
        checkout = {
          ...checkout,
          status: refreshed.status,
          hostedCheckoutRef: refreshed.hostedCheckoutRef,
          alternateCheckoutRef: refreshed.alternateCheckoutRef,
        };
      }
    }
    const samePayment = existing?.paymentRef === event.paymentRef;
    if (existing && !samePayment && !checkoutMatches) {
      console.warn(
        "[worker] multiple NOWPayments payment IDs share an order; only one payment per order is supported",
      );
    }
    const unmatchedInvoiceLessEventAfterFound = Boolean(
      checkout?.reconciliationResolution === "FOUND" &&
      !providerInvoiceRef &&
      !samePayment,
    );
    if (unmatchedInvoiceLessEventAfterFound) {
      checkoutMatches = false;
    }
    const effectiveCheckoutAttribution = invoiceAlreadyCompleted
      ? null
      : checkoutAttribution;
    const attributionMatches =
      !invoiceAlreadyCompleted &&
      (Boolean(checkoutAttribution) || checkoutMatches);
    const attributedClickId = invoiceAlreadyCompleted
      ? null
      : (effectiveCheckoutAttribution?.clickId ??
        (checkoutMatches ? checkout?.clickId : null) ??
        null);
    const nextStatus = samePayment
      ? statusAfter(existing?.status ?? null, event.providerStatus)
      : event.providerStatus;
    const providerFee =
      event.providerStatus === NOWPAYMENTS_PAYMENT_STATUS.FINISHED
        ? (() => {
            const eligibleSaleMinor = saleAmount.mul(
              10 ** currencyMinorUnitExponent(event.saleCurrency),
            );
            const resolved = resolveProviderFee({
              eligibleSaleMinor,
              currency: event.saleCurrency,
              actualFeeMinor: nowPaymentsFeeMinorInCurrency(
                event.rawPayload,
                event.saleCurrency,
                eligibleSaleMinor,
              ),
              fallbackPercent: connection.feeFallbackPercent,
            });
            if (resolved.providerFeeSource === null) {
              return samePayment ? undefined : null;
            }
            if (
              samePayment &&
              existing?.providerFeeSource === ProviderFeeSource.ACTUAL &&
              resolved.providerFeeSource === ProviderFeeSource.FALLBACK
            ) {
              return undefined;
            }
            return resolved;
          })()
        : undefined;
    let paymentRecord: PaymentRecord | null = null;
    const mayReplaceStoredPayment =
      (!existing && !unmatchedInvoiceLessEventAfterFound) ||
      samePayment ||
      checkoutMatches;
    if (mayReplaceStoredPayment) {
      paymentRecord = await upsertPaymentRecord(tx, {
        merchantId: row.merchantId,
        connectionId: connection.id,
        checkoutId: checkout?.id ?? null,
        clickId: attributedClickId,
        sourceOrderId,
        paymentRef: event.paymentRef,
        checkoutRef:
          providerInvoiceRef ??
          (checkoutMatches &&
          event.checkoutRef &&
          event.checkoutRef !== sourceOrderId
            ? event.checkoutRef
            : null),
        saleAmount,
        saleCurrency: event.saleCurrency,
        cryptoAmount,
        cryptoCurrency: event.cryptoCurrency,
        cryptoNetwork: event.cryptoNetwork,
        status: event.providerStatus,
        providerFee,
      });
    }

    if (
      nextStatus === NOWPAYMENTS_PAYMENT_STATUS.FINISHED &&
      event.providerStatus === NOWPAYMENTS_PAYMENT_STATUS.FINISHED
    ) {
      if (checkout && !checkoutMatches) {
        console.warn(
          `[worker] payment ${event.paymentRef} did not match its stored checkout`,
        );
      }
      if (paymentRecord && attributionMatches) {
        await createCommissionIfEligible(tx, {
          merchantId: row.merchantId,
          event,
          clickId: attributedClickId,
          paymentRecord,
          clickMatches: !checkout?.refundReconciliationPendingAt,
          checkoutAttributionAt:
            effectiveCheckoutAttribution?.createdAt ?? null,
          allowRefundVoidRestore: Boolean(
            !samePayment &&
            event.providerInvoiceRef &&
            checkout?.hostedCheckoutRef === event.providerInvoiceRef,
          ),
        });
      }
    }

    if (
      nextStatus === NOWPAYMENTS_PAYMENT_STATUS.REFUNDED &&
      paymentRecord &&
      (samePayment || checkoutMatches)
    ) {
      await markCommissionRefunded(tx, paymentRecord.id);
    }

    if (
      checkout &&
      paymentRecord &&
      checkoutMatches &&
      event.providerStatus === NOWPAYMENTS_PAYMENT_STATUS.FINISHED &&
      nextStatus === NOWPAYMENTS_PAYMENT_STATUS.FINISHED &&
      checkout.status === "READY" &&
      checkout.hostedCheckoutRef !== null &&
      (!providerInvoiceRef ||
        checkout.hostedCheckoutRef === providerInvoiceRef) &&
      checkout.refundReconciliationPendingAt === null
    ) {
      await releaseCheckoutConflictHold(
        tx,
        checkout.id,
        row.merchantId,
        sourceOrderId,
        checkout.hostedCheckoutRef,
        NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
        paymentTerminalSnapshot(event, paymentRecord),
      );
    }

    if (
      checkout &&
      paymentRecord &&
      checkoutMatches &&
      event.providerStatus === NOWPAYMENTS_PAYMENT_STATUS.REFUNDED &&
      nextStatus === NOWPAYMENTS_PAYMENT_STATUS.REFUNDED &&
      checkout.status === "READY" &&
      checkout.hostedCheckoutRef !== null &&
      checkout.hostedCheckoutRef === providerInvoiceRef
    ) {
      await releaseCheckoutConflictHold(
        tx,
        checkout.id,
        row.merchantId,
        sourceOrderId,
        checkout.hostedCheckoutRef,
        NOWPAYMENTS_PAYMENT_STATUS.REFUNDED,
        paymentTerminalSnapshot(event, paymentRecord),
      );
    }
  });
}

/**
 * Reconcile a checkout attribution that reached Supaffi after its verified
 * payment event had already been processed. The provider event remains the
 * only source of payment facts; the browser can add only the click mapping.
 */
export async function reconcileNowPaymentsCheckoutAttribution(input: {
  merchantId: string;
  providerCheckoutRef: string;
  clickId: string;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const attribution = await tx.checkoutAttribution.findUnique({
      where: {
        merchantId_provider_providerCheckoutRef: {
          merchantId: input.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          providerCheckoutRef: input.providerCheckoutRef,
        },
      },
      select: { clickId: true, createdAt: true },
    });
    if (!attribution || attribution.clickId !== input.clickId) return;

    const candidates = await tx.paymentRecord.findMany({
      where: {
        merchantId: input.merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        checkoutRef: input.providerCheckoutRef,
        status: NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
      },
      take: 2,
    });
    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    if (!candidate.paymentRef || !candidate.sourceOrderId) return;

    await lockNowPaymentsReference(
      tx,
      input.merchantId,
      "payment",
      candidate.paymentRef,
    );
    const secondaryLocks = [
      { kind: "invoice" as const, reference: input.providerCheckoutRef },
      { kind: "order" as const, reference: candidate.sourceOrderId },
    ].sort((left, right) =>
      `${left.kind}:${left.reference}`.localeCompare(
        `${right.kind}:${right.reference}`,
      ),
    );
    for (const lock of secondaryLocks) {
      await lockNowPaymentsReference(
        tx,
        input.merchantId,
        lock.kind,
        lock.reference,
      );
    }

    const payment = await tx.paymentRecord.findUnique({
      where: { id: candidate.id },
    });
    if (
      !payment ||
      payment.status !== NOWPAYMENTS_PAYMENT_STATUS.FINISHED ||
      payment.checkoutRef !== input.providerCheckoutRef ||
      (payment.clickId && payment.clickId !== input.clickId)
    )
      return;

    const eventRecord = await tx.webhookEvent.findUnique({
      where: {
        merchantId_provider_providerEventId: {
          merchantId: input.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          providerEventId: `${payment.paymentRef}:finished`,
        },
      },
      select: { payload: true, createdAt: true },
    });
    if (!eventRecord) return;
    const event = parseQueuedEvent(eventRecord.payload);
    if (
      !event ||
      event.providerStatus !== NOWPAYMENTS_PAYMENT_STATUS.FINISHED ||
      event.paymentRef !== payment.paymentRef
    )
      return;
    const attributionCutoff = providerTimestamp(event) ?? eventRecord.createdAt;
    if (attribution.createdAt > attributionCutoff) return;

    const linkedPayment =
      payment.clickId === input.clickId
        ? payment
        : await tx.paymentRecord.update({
            where: { id: payment.id },
            data: { clickId: input.clickId },
          });
    await createCommissionIfEligible(tx, {
      merchantId: input.merchantId,
      event,
      clickId: input.clickId,
      paymentRecord: linkedPayment,
      clickMatches: true,
      checkoutAttributionAt: attribution.createdAt,
      allowRefundVoidRestore: false,
    });
  });
}
