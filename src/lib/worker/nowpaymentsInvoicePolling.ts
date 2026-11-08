import { PaymentProvider } from "@/lib/payments/types";
import { NOWPAYMENTS_PAYMENT_STATUS } from "@/lib/payments/providers/nowpaymentsApi";
import {
  nextNowPaymentsPollAt,
  nextNowPaymentsPollErrorAt,
} from "@/lib/payments/providers/nowpaymentsPolling";
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { SqlSchema } from "@/lib/sqlSchema";
import { listNowPaymentsPaymentsByInvoice } from "@/lib/payments/providers/nowpaymentsApi";
import { Prisma } from "@prisma/client";

const POLL_BATCH_SIZE = 20;
const POLL_LEASE_MS = 2 * 60_000;
const POLL_CONCURRENCY = 4;

const EVENT_KIND_BY_STATUS = {
  [NOWPAYMENTS_PAYMENT_STATUS.WAITING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.SENDING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.PARTIALLY_PAID]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.FINISHED]: "payment_succeeded",
  [NOWPAYMENTS_PAYMENT_STATUS.FAILED]: "payment_failed",
  [NOWPAYMENTS_PAYMENT_STATUS.EXPIRED]: "payment_failed",
  [NOWPAYMENTS_PAYMENT_STATUS.REFUNDED]: "payment_refunded",
} as const;

const FINAL_STATUSES = new Set<string>([
  NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
  NOWPAYMENTS_PAYMENT_STATUS.FAILED,
  NOWPAYMENTS_PAYMENT_STATUS.EXPIRED,
  NOWPAYMENTS_PAYMENT_STATUS.REFUNDED,
]);

type PaymentListItem = Awaited<
  ReturnType<typeof listNowPaymentsPaymentsByInvoice>
>[number];

const pollableAttributionSelect = {
  id: true,
  merchantId: true,
  providerCheckoutRef: true,
  pollAttempts: true,
  pollFailures: true,
  click: { select: { expiresAt: true } },
  merchant: {
    select: {
      paymentConnections: {
        where: { provider: PaymentProvider.NOWPAYMENTS.database },
        take: 1,
        select: {
          enabled: true,
          status: true,
          apiKeyEnc: true,
          apiAccountEmailEnc: true,
          apiAccountPasswordEnc: true,
        },
      },
    },
  },
} satisfies Prisma.CheckoutAttributionSelect;

type PollableAttribution = Prisma.CheckoutAttributionGetPayload<{
  select: typeof pollableAttributionSelect;
}>;

async function claimDueAttributions(now: Date): Promise<string[]> {
  return db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.CheckoutAttribution.id}
      FROM ${SqlSchema.tables.CheckoutAttribution.name}
      WHERE ${SqlSchema.tables.CheckoutAttribution.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
        AND ${SqlSchema.tables.CheckoutAttribution.pollClosedAt} IS NULL
        AND ${SqlSchema.tables.CheckoutAttribution.pollNextAt} <= ${now}
      ORDER BY ${SqlSchema.tables.CheckoutAttribution.pollNextAt}
      LIMIT ${POLL_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `);
    if (due.length === 0) return [];

    await tx.checkoutAttribution.updateMany({
      where: { id: { in: due.map(({ id }) => id) }, pollClosedAt: null },
      data: {
        pollNextAt: new Date(now.getTime() + POLL_LEASE_MS),
        pollLastAttemptAt: now,
        pollAttempts: { increment: 1 },
      },
    });
    return due.map(({ id }) => id);
  });
}

function eventForPayment(
  merchantId: string,
  invoiceId: string,
  payment: PaymentListItem,
  now: Date,
): Prisma.WebhookEventCreateManyInput {
  const occurredAt = payment.updated_at ?? now.toISOString();
  const rawPayload = {
    payment_id: payment.payment_id,
    payment_status: payment.payment_status,
    invoice_id: payment.invoice_id ?? invoiceId,
    order_id: payment.order_id,
    price_amount: payment.price_amount,
    price_currency: payment.price_currency.toUpperCase(),
    pay_amount: payment.pay_amount,
    pay_currency: payment.pay_currency,
    actually_paid: payment.actually_paid,
    network: payment.network,
    updated_at: occurredAt,
  } satisfies Prisma.InputJsonObject;

  return {
    merchantId,
    provider: PaymentProvider.NOWPAYMENTS.database,
    providerEventId: `${payment.payment_id}:${payment.payment_status}`,
    payload: {
      provider: PaymentProvider.NOWPAYMENTS.id,
      eventId: `${payment.payment_id}:${payment.payment_status}`,
      kind: EVENT_KIND_BY_STATUS[payment.payment_status],
      paymentRef: payment.payment_id,
      checkoutRef: invoiceId,
      saleAmount: payment.price_amount,
      saleCurrency: payment.price_currency,
      cryptoAmount: payment.actually_paid,
      cryptoCurrency: payment.pay_currency,
      occurredAt,
      rawPayload,
    },
  };
}

function activeStatus(payments: readonly PaymentListItem[]): string | null {
  const statuses = payments.map(({ payment_status }) => payment_status);
  if (
    statuses.some((status) => status === NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING)
  )
    return NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING;
  if (
    statuses.some((status) => status === NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED)
  )
    return NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED;
  if (statuses.some((status) => status === NOWPAYMENTS_PAYMENT_STATUS.SENDING))
    return NOWPAYMENTS_PAYMENT_STATUS.SENDING;
  return statuses.find((status) => !FINAL_STATUSES.has(status)) ?? null;
}

function safePollError(error: unknown): string {
  if (
    error instanceof Error &&
    /^NOWPayments API request failed \(\d{3}\)$/.test(error.message)
  ) {
    return error.message;
  }
  return "Could not check this invoice with NOWPayments.";
}

async function pollAttribution(
  attribution: PollableAttribution,
  now: Date,
): Promise<void> {
  const deadline = attribution.click.expiresAt;
  if (deadline.getTime() <= now.getTime()) {
    await db.checkoutAttribution.updateMany({
      where: { id: attribution.id, pollClosedAt: null },
      data: { pollNextAt: null, pollClosedAt: deadline },
    });
    return;
  }

  const connection = attribution.merchant.paymentConnections[0];
  if (
    !connection?.enabled ||
    connection.status !== "CONNECTED" ||
    !connection.apiKeyEnc ||
    !connection.apiAccountEmailEnc ||
    !connection.apiAccountPasswordEnc
  ) {
    // Keep the attribution available for later setup, but don't spin on an
    // invoice until the merchant has connected a payment-view account.
    await db.checkoutAttribution.updateMany({
      where: { id: attribution.id, pollClosedAt: null },
      data: { pollNextAt: null },
    });
    return;
  }

  try {
    const payments = await listNowPaymentsPaymentsByInvoice(
      attribution.providerCheckoutRef,
      {
        apiKey: decrypt(connection.apiKeyEnc),
        email: decrypt(connection.apiAccountEmailEnc),
        password: decrypt(connection.apiAccountPasswordEnc),
      },
    );
    const uniquePayments = [
      ...new Map(
        payments.map((payment) => [payment.payment_id, payment]),
      ).values(),
    ];

    if (uniquePayments.length > 0) {
      await db.webhookEvent.createMany({
        data: uniquePayments.map((payment) =>
          eventForPayment(
            attribution.merchantId,
            attribution.providerCheckoutRef,
            payment,
            now,
          ),
        ),
        skipDuplicates: true,
      });
    }

    const status = activeStatus(uniquePayments);
    const hasFinished = uniquePayments.some(
      ({ payment_status }) =>
        payment_status === NOWPAYMENTS_PAYMENT_STATUS.FINISHED,
    );
    const allTerminal =
      uniquePayments.length > 0 &&
      uniquePayments.every(({ payment_status }) =>
        FINAL_STATUSES.has(payment_status),
      );
    const nextPollAt = nextNowPaymentsPollAt({
      noPaymentChecks:
        uniquePayments.length > 0
          ? 0
          : Math.max(0, attribution.pollAttempts - 1),
      paymentStatus: status,
      now,
      deadline,
    });
    const close = hasFinished || allTerminal || !nextPollAt;

    await db.checkoutAttribution.updateMany({
      where: { id: attribution.id, pollClosedAt: null },
      data: {
        pollNextAt: close ? null : nextPollAt,
        pollClosedAt: close ? now : null,
        pollFailures: 0,
        pollLastError: null,
      },
    });
  } catch (error) {
    const nextPollAt = nextNowPaymentsPollErrorAt({
      failures: attribution.pollFailures,
      now,
      deadline,
    });
    await db.checkoutAttribution.updateMany({
      where: { id: attribution.id, pollClosedAt: null },
      data: {
        pollNextAt: nextPollAt,
        pollClosedAt: nextPollAt ? null : now,
        pollFailures: { increment: 1 },
        pollLastError: safePollError(error),
      },
    });
  }
}

/** Check only due, captured invoices; row locks coordinate multiple workers. */
export async function runNowPaymentsInvoicePoller(): Promise<void> {
  const now = new Date();
  const ids = await claimDueAttributions(now);
  if (ids.length === 0) return;

  const attributions = await db.checkoutAttribution.findMany({
    where: { id: { in: ids } },
    select: pollableAttributionSelect,
  });

  for (let index = 0; index < attributions.length; index += POLL_CONCURRENCY) {
    const batch = attributions.slice(index, index + POLL_CONCURRENCY);
    await Promise.all(
      batch.map((attribution) => pollAttribution(attribution, now)),
    );
  }
}
