import { PaymentProvider } from "@/lib/payments/types";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CommerceCheckout, PaymentRecord, WebhookEvent } from "@prisma/client";
import { db } from "@/lib/db";
import { SqlSchema } from "@/lib/sqlSchema";
import {
  recordCommerceCheckoutReference,
  releaseCheckoutConflictHold,
} from "@/lib/commerceCheckoutReferences";
import { commissionRateFor, computePayableAt } from "../commission";
import { commissionDurationForClick, referralStillEarns } from "../referralDuration";

type JsonObject = Record<string, unknown>;

type QueuedNowPaymentsEvent = {
  provider: typeof PaymentProvider.NOWPAYMENTS.id;
  eventId: string;
  kind: "payment_succeeded" | "payment_failed" | "payment_refunded" | "payment_pending";
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
  waiting: 0,
  confirming: 1,
  confirmed: 2,
  partially_paid: 3,
  sending: 4,
  failed: 5,
  expired: 5,
  finished: 6,
  refunded: 7,
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decimalText(value: unknown, maxIntegerDigits: number, maxFractionDigits: number): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || match[1].length > maxIntegerDigits || (match[2]?.length ?? 0) > maxFractionDigits) return null;
  return value;
}

function parseQueuedEvent(payload: unknown): QueuedNowPaymentsEvent | null {
  if (!isObject(payload) || payload.provider !== PaymentProvider.NOWPAYMENTS.id) return null;
  if (
    typeof payload.eventId !== "string" ||
    typeof payload.kind !== "string" ||
    !["payment_succeeded", "payment_failed", "payment_refunded", "payment_pending"].includes(payload.kind) ||
    typeof payload.paymentRef !== "string" ||
    !payload.paymentRef.trim() ||
    typeof payload.saleAmount !== "string" ||
    typeof payload.saleCurrency !== "string" ||
    typeof payload.occurredAt !== "string" ||
    !isObject(payload.rawPayload)
  ) return null;

  const raw = payload.rawPayload;
  const providerStatus = raw.payment_status;
  const rawPaymentRef =
    typeof raw.payment_id === "string"
      ? raw.payment_id
      : typeof raw.payment_id === "number" && Number.isSafeInteger(raw.payment_id)
        ? String(raw.payment_id)
        : null;
  const providerInvoiceRef =
    typeof raw.invoice_id === "string" && raw.invoice_id.trim()
      ? raw.invoice_id
      : typeof raw.invoice_id === "number" && Number.isSafeInteger(raw.invoice_id)
        ? String(raw.invoice_id)
        : null;
  const sourceOrderId =
    typeof raw.order_id === "string" && raw.order_id.trim()
      ? raw.order_id
      : rawPaymentRef ?? "";
  if (
    !rawPaymentRef ||
    !sourceOrderId.trim() ||
    sourceOrderId.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(sourceOrderId) ||
    typeof providerStatus !== "string" ||
    !Object.prototype.hasOwnProperty.call(PAYMENT_STATUS_PRIORITY, providerStatus) ||
    rawPaymentRef !== payload.paymentRef ||
    (
      payload.eventId !== `${payload.paymentRef}:${providerStatus}` &&
      !(payload.reconciliation === true && /^owner-reconcile:[a-f0-9]{64}$/.test(payload.eventId))
    )
  ) return null;

  const saleAmount = decimalText(payload.saleAmount, 16, 2);
  const saleCurrency = payload.saleCurrency.toLowerCase();
  const occurredAt = new Date(payload.occurredAt);
  if (!saleAmount || !/^[a-z]{3}$/.test(saleCurrency) || Number.isNaN(occurredAt.getTime())) return null;

  const cryptoAmount = decimalText(payload.cryptoAmount, 20, 18);
  const cryptoCurrency =
    typeof payload.cryptoCurrency === "string" && /^[a-z0-9_-]{2,20}$/i.test(payload.cryptoCurrency)
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
    checkoutRef: typeof payload.checkoutRef === "string" ? payload.checkoutRef : null,
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

/** Use signed provider update time when available, otherwise IPN receive time. */
function providerUpdateTime(event: QueuedNowPaymentsEvent): Date | null {
  const value = event.rawPayload.updated_at;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function statusAfter(current: string | null, incoming: string): string {
  if (!current) return incoming;
  const prior = current.toLowerCase();
  const priorPriority = PAYMENT_STATUS_PRIORITY[prior] ?? -1;
  const incomingPriority = PAYMENT_STATUS_PRIORITY[incoming] ?? -1;
  if (prior === "refunded" || incoming === "refunded") return "refunded";
  if (prior === "finished" || incoming === "finished") return "finished";
  if ((prior === "failed" || prior === "expired") && incomingPriority < 5) return prior;
  if ((incoming === "failed" || incoming === "expired") && priorPriority < 5) return incoming;
  return incomingPriority >= priorPriority ? incoming : prior;
}

function commissionAmount(saleAmount: Prisma.Decimal, rate: Prisma.Decimal): Prisma.Decimal {
  return saleAmount
    .mul(rate)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function paymentTerminalSnapshot(
  event: QueuedNowPaymentsEvent,
  paymentRecord: PaymentRecord
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
  }
): Promise<{ record: PaymentRecord; previousStatus: string | null }> {
  const existing = await tx.paymentRecord.findUnique({
    where: {
      merchantId_provider_sourceOrderId: {
        merchantId: input.merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        sourceOrderId: input.sourceOrderId,
      },
    },
  });
  const samePayment = existing?.paymentRef === input.paymentRef;
  const status = samePayment ? statusAfter(existing?.status ?? null, input.status) : input.status;
  const cryptoAmount = samePayment && existing?.cryptoAmount && input.cryptoAmount
    ? (existing.cryptoAmount.gte(input.cryptoAmount) ? existing.cryptoAmount : input.cryptoAmount)
    : samePayment
      ? input.cryptoAmount ?? existing?.cryptoAmount ?? null
      : input.cryptoAmount;
  const checkoutRef = samePayment
    ? input.checkoutRef ?? existing?.checkoutRef ?? null
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
          cryptoCurrency: samePayment ? input.cryptoCurrency ?? existing.cryptoCurrency : input.cryptoCurrency,
          cryptoNetwork: samePayment ? input.cryptoNetwork ?? existing.cryptoNetwork : input.cryptoNetwork,
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
          status,
          clickId: input.clickId,
        },
      });

  return { record, previousStatus: samePayment ? existing?.status ?? null : null };
}

async function createCommissionIfEligible(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    event: QueuedNowPaymentsEvent;
    clickId: string | null;
    paymentRecord: PaymentRecord;
    clickMatches: boolean;
    allowRefundVoidRestore: boolean;
  }
): Promise<void> {
  const { event } = input;
  if (!input.clickId || !input.clickMatches) return;

  const existing = await tx.commission.findUnique({
    where: { paymentRecordId: input.paymentRecord.id },
    select: { id: true, status: true, voidReason: true, paidAt: true, flagReason: true },
  });
  // A replacement payment for the owner-selected invoice may reuse only the
  // unpaid commission voided by the prior payment's refund. PAID and other
  // VOIDED rows remain final.
  const restoreRefundVoid = Boolean(
    input.allowRefundVoidRestore &&
    existing &&
    existing.status === "VOIDED" &&
    existing.voidReason === "refund" &&
    existing.flagReason === null &&
    existing.paidAt === null
  );
  if (existing && !restoreRefundVoid) return;

  const lockedClicks = await tx.$queryRaw<{ fraudConfirmedAt: Date | null }[]>(Prisma.sql`
    SELECT ${SqlSchema.tables.Click.fraudConfirmedAt}
    FROM ${SqlSchema.tables.Click.name}
    WHERE ${SqlSchema.tables.Click.id} = ${input.clickId}
      AND ${SqlSchema.tables.Click.merchantId} = ${input.merchantId}
    FOR UPDATE
  `);
  const lockedClick = lockedClicks[0];
  if (!lockedClick || lockedClick.fraudConfirmedAt !== null) return;

  const click = await tx.click.findFirst({
    where: { id: input.clickId, merchantId: input.merchantId },
    include: {
      affiliate: { include: { program: true } },
      link: { select: { commissionRateOverride: true, activeFrom: true, activeUntil: true } },
    },
  });
  if (!click || event.occurredAt < click.createdAt || event.occurredAt > click.expiresAt) return;

  const linkActiveAtClick =
    (!click.link?.activeFrom || click.createdAt >= click.link.activeFrom) &&
    (!click.link?.activeUntil || click.createdAt <= click.link.activeUntil);
  const linkForRate = linkActiveAtClick ? click.link : null;
  const rate = new Prisma.Decimal(
    commissionRateFor(click.affiliate, click.affiliate.program, linkForRate, click)
  );
  if (rate.lte(0)) return;

  const sale = { ref: event.paymentRef, at: event.occurredAt };
  if (!(await referralStillEarns(
    input.merchantId,
    click.id,
    click.affiliate.program,
    sale,
    [],
    tx,
    commissionDurationForClick(click.affiliate.program, click)
  ))) return;

  const saleAmount = input.paymentRecord.saleAmount;
  const amount = commissionAmount(saleAmount, rate);
  if (amount.lte(0)) return;

  const commissionData = {
    affiliateId: click.affiliateId,
    merchantId: click.merchantId,
    clickId: click.id,
    paymentRecordId: input.paymentRecord.id,
    stripePaymentRef: null,
    amount,
    grossAmount: amount,
    currency: input.paymentRecord.saleCurrency,
    saleAmount,
    status: "PENDING" as const,
    payableAt: computePayableAt(
      click.affiliate.program,
      undefined,
      click.holdingPeriodDaysSnapshot ?? undefined,
    ),
    paidAt: null,
    voidedAt: null,
    voidReason: null,
    flagReason: null,
    disputeOpenedAt: null,
    checkoutConflictHeldAt: null,
  };
  if (existing && restoreRefundVoid) {
    await tx.commission.update({ where: { id: existing.id }, data: commissionData });
  } else {
    await tx.commission.create({ data: commissionData });
  }
}

async function markCommissionRefunded(tx: Prisma.TransactionClient, paymentRecordId: string): Promise<void> {
  await tx.commission.updateMany({
    where: {
      paymentRecordId,
      status: { in: ["PENDING", "PAYABLE", "FLAGGED"] },
    },
    data: {
      status: "VOIDED",
      voidedAt: new Date(),
      voidReason: "refund",
      disputeOpenedAt: null,
    },
  });
}

/** Process one signature-verified NOWPayments event from the durable webhook queue. */
export async function handleNowPaymentsEvent(row: WebhookEvent): Promise<void> {
  const event = parseQueuedEvent(row.payload);
  if (!event) throw new Error("Queued NOWPayments event is invalid");

  const saleAmount = new Prisma.Decimal(event.saleAmount);
  const cryptoAmount = event.cryptoAmount ? new Prisma.Decimal(event.cryptoAmount) : null;

  await db.$transaction(async (tx) => {
    // Serialize different statuses for the same order across worker instances.
    // The key is scoped to the Merchant and the provider order reference.
    const lockSeed = `${row.merchantId}\0${event.providerInvoiceRef ?? event.sourceOrderId}`;
    const lockBytes = createHash("sha256").update(lockSeed, "utf8").digest();
    await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_advisory_xact_lock(${lockBytes.readInt32BE(0)}::integer, ${lockBytes.readInt32BE(4)}::integer) IS NULL AS locked
    `;

    const connection = await tx.paymentConnection.findUnique({
      where: { merchantId_provider: { merchantId: row.merchantId, provider: PaymentProvider.NOWPAYMENTS.database } },
      select: { id: true },
    });
    if (!connection) throw new Error("NOWPayments connection is missing for the queued payment event");

    const checkoutKey = await tx.commerceCheckout.findUnique({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: row.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: event.sourceOrderId,
        },
      },
      select: { id: true },
    });
    const storedCheckoutAttribution = event.providerInvoiceRef
      ? await tx.checkoutAttribution.findUnique({
          where: {
            merchantId_provider_providerCheckoutRef: {
              merchantId: row.merchantId,
              provider: PaymentProvider.NOWPAYMENTS.database,
              providerCheckoutRef: event.providerInvoiceRef,
            },
          },
          select: { clickId: true, createdAt: true },
        })
      : null;
    // A public browser registration may only match a provider event if it
    // reached Supaffi before the signed payment update. Prefer NOWPayments'
    // signed update timestamp, falling back to when Supaffi received the IPN.
    const attributionCutoff = providerUpdateTime(event) ?? row.createdAt;
    const checkoutAttribution = storedCheckoutAttribution &&
      storedCheckoutAttribution.createdAt <= attributionCutoff
      ? storedCheckoutAttribution
      : null;
    const otherCompletedInvoicePayment = event.providerInvoiceRef
      ? await tx.paymentRecord.findFirst({
          where: {
            merchantId: row.merchantId,
            provider: PaymentProvider.NOWPAYMENTS.database,
            checkoutRef: event.providerInvoiceRef,
            paymentRef: { not: event.paymentRef },
            status: { in: ["finished", "refunded"] },
          },
          select: { id: true },
        })
      : null;
    const invoiceAlreadyCompleted = Boolean(otherCompletedInvoicePayment);
    if (invoiceAlreadyCompleted) {
      console.warn("[worker] NOWPayments invoice already has a completed payment; later payment left unattributed");
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
    const currencyMatches = Boolean(checkout && checkout.currency.toLowerCase() === event.saleCurrency);
    const invoiceMatches = Boolean(
      checkout &&
      event.providerInvoiceRef &&
      !checkout.alternateCheckoutRef &&
      checkout.hostedCheckoutRef &&
      checkout.hostedCheckoutRef === event.providerInvoiceRef
    );
    let checkoutMatches = Boolean(
      checkout &&
      checkout.status === "READY" &&
      amountMatches &&
      currencyMatches &&
      invoiceMatches
    );
    if (checkout && event.providerInvoiceRef) {
      const reference = await recordCommerceCheckoutReference(tx, checkout.id, event.providerInvoiceRef);
      const refreshed = await tx.commerceCheckout.findUnique({
        where: { id: checkout.id },
        select: { status: true, hostedCheckoutRef: true, alternateCheckoutRef: true },
      });
      checkoutMatches = Boolean(
        checkoutMatches &&
        reference.matchesPrimary &&
        refreshed?.status === "READY" &&
        refreshed.hostedCheckoutRef === event.providerInvoiceRef &&
        !refreshed.alternateCheckoutRef
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
    const existing = await tx.paymentRecord.findUnique({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: row.merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          sourceOrderId: event.sourceOrderId,
        },
      },
      select: { status: true, paymentRef: true },
    });
    const samePayment = existing?.paymentRef === event.paymentRef;
    if (existing && !samePayment && !checkoutMatches) {
      console.warn("[worker] multiple NOWPayments payment IDs share an order; only one payment per order is supported");
    }
    const unmatchedInvoiceLessEventAfterFound = Boolean(
      checkout?.reconciliationResolution === "FOUND" &&
      !event.providerInvoiceRef &&
      !samePayment
    );
    if (unmatchedInvoiceLessEventAfterFound) {
      checkoutMatches = false;
    }
    const effectiveCheckoutAttribution = invoiceAlreadyCompleted ? null : checkoutAttribution;
    const attributionMatches = !invoiceAlreadyCompleted && (Boolean(checkoutAttribution) || checkoutMatches);
    const attributedClickId = invoiceAlreadyCompleted
      ? null
      : effectiveCheckoutAttribution?.clickId ?? (checkoutMatches ? checkout?.clickId : null) ?? null;
    const nextStatus = samePayment
      ? statusAfter(existing?.status ?? null, event.providerStatus)
      : event.providerStatus;
    let paymentRecord: PaymentRecord | null = null;
    let previousStatus: string | null = null;
    const mayReplaceStoredPayment = (!existing && !unmatchedInvoiceLessEventAfterFound) || samePayment || checkoutMatches;
    if (mayReplaceStoredPayment) {
      const upserted = await upsertPaymentRecord(tx, {
        merchantId: row.merchantId,
        connectionId: connection.id,
        checkoutId: checkout?.id ?? null,
        clickId: attributedClickId,
        sourceOrderId: event.sourceOrderId,
        paymentRef: event.paymentRef,
        checkoutRef: event.providerInvoiceRef ??
          (checkoutMatches && event.checkoutRef && event.checkoutRef !== event.sourceOrderId ? event.checkoutRef : null),
        saleAmount,
        saleCurrency: event.saleCurrency,
        cryptoAmount,
        cryptoCurrency: event.cryptoCurrency,
        cryptoNetwork: event.cryptoNetwork,
        status: event.providerStatus,
      });
      paymentRecord = upserted.record;
      previousStatus = upserted.previousStatus;
    }

    if (nextStatus === "finished" && event.providerStatus === "finished") {
      if (checkout && !checkoutMatches) {
        console.warn(`[worker] payment ${event.paymentRef} did not match its stored checkout`);
      }
      if (paymentRecord && attributionMatches) {
        await createCommissionIfEligible(tx, {
          merchantId: row.merchantId,
          event,
          clickId: attributedClickId,
          paymentRecord,
          clickMatches: !checkout?.refundReconciliationPendingAt,
          allowRefundVoidRestore: Boolean(
            !samePayment &&
            event.providerInvoiceRef &&
            checkout?.hostedCheckoutRef === event.providerInvoiceRef
          ),
        });
      }
    }

    if (nextStatus === "refunded" && paymentRecord && (samePayment || checkoutMatches)) {
      await markCommissionRefunded(tx, paymentRecord.id);
    }

    if (
      checkout &&
      paymentRecord &&
      checkoutMatches &&
      event.providerStatus === "finished" &&
      nextStatus === "finished" &&
      checkout.status === "READY" &&
      checkout.hostedCheckoutRef !== null &&
      (!event.providerInvoiceRef || checkout.hostedCheckoutRef === event.providerInvoiceRef) &&
      checkout.refundReconciliationPendingAt === null
    ) {
      await releaseCheckoutConflictHold(
        tx,
        checkout.id,
        row.merchantId,
        event.sourceOrderId,
        checkout.hostedCheckoutRef,
        "finished",
        paymentTerminalSnapshot(event, paymentRecord)
      );
    }

    if (
      checkout &&
      paymentRecord &&
      checkoutMatches &&
      event.providerStatus === "refunded" &&
      nextStatus === "refunded" &&
      checkout.status === "READY" &&
      checkout.hostedCheckoutRef !== null &&
      checkout.hostedCheckoutRef === event.providerInvoiceRef
    ) {
      await releaseCheckoutConflictHold(
        tx,
        checkout.id,
        row.merchantId,
        event.sourceOrderId,
        checkout.hostedCheckoutRef,
        "refunded",
        paymentTerminalSnapshot(event, paymentRecord)
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
        status: "finished",
      },
      take: 2,
    });
    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    if (!candidate.paymentRef || !candidate.sourceOrderId) return;

    const lockSeed = `${input.merchantId}\0${candidate.sourceOrderId}`;
    const lockBytes = createHash("sha256").update(lockSeed, "utf8").digest();
    await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_advisory_xact_lock(${lockBytes.readInt32BE(0)}::integer, ${lockBytes.readInt32BE(4)}::integer) IS NULL AS locked
    `;

    const payment = await tx.paymentRecord.findUnique({ where: { id: candidate.id } });
    if (
      !payment ||
      payment.status !== "finished" ||
      payment.checkoutRef !== input.providerCheckoutRef ||
      payment.clickId && payment.clickId !== input.clickId
    ) return;

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
      event.providerStatus !== "finished" ||
      event.paymentRef !== payment.paymentRef ||
      event.sourceOrderId !== payment.sourceOrderId ||
      event.providerInvoiceRef !== input.providerCheckoutRef
    ) return;
    const attributionCutoff = providerUpdateTime(event) ?? eventRecord.createdAt;
    if (attribution.createdAt > attributionCutoff) return;

    const linkedPayment = payment.clickId === input.clickId
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
      allowRefundVoidRestore: false,
    });
  });
}

