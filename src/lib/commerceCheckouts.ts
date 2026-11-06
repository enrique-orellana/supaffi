import { PaymentProvider } from "@/lib/payments/types";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getNowPaymentsCheckoutConnection } from "@/lib/paymentConnections";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import { CheckoutProviderError } from "@/lib/payments/types";
import { SqlSchema } from "@/lib/sqlSchema";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";
import {
  holdCheckoutDeliveries,
  holdUnpaidCheckoutCommissions,
  recordCommerceCheckoutReference,
} from "@/lib/commerceCheckoutReferences";

const CHECKOUT_PROVIDER = PaymentProvider.NOWPAYMENTS.database;
const CHECKOUT_LEASE_MS = 10 * 60 * 1000;
const RECONCILIATION_GRACE_MS = 5 * 60 * 1000;

export type CommerceCheckoutInput = {
  sourceOrderId: string;
  amount: string;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  referralToken?: string;
};

export type CommerceCheckoutResult =
  | { kind: "ready"; checkoutUrl: string; checkoutRef: string | null }
  | { kind: "accepted"; retryAt: Date }
  | { kind: "uncertain" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export type UncertainCommerceCheckout = {
  id: string;
  sourceOrderId: string;
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  primaryInvoiceRef: string | null;
  alternateInvoiceRef: string | null;
};

export type UncertainCommerceCheckoutPage = {
  checkouts: UncertainCommerceCheckout[];
  page: number;
  pageCount: number;
  totalCount: number;
};

type ClaimResult =
  | { kind: "claimed"; checkoutId: string; attempts: number }
  | { kind: "ready"; checkoutUrl: string; checkoutRef: string | null }
  | { kind: "accepted"; retryAt: Date }
  | { kind: "uncertain" }
  | { kind: "conflict" };

function normalizeAmount(value: string): string | null {
  const raw = value.trim();
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const amount = `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
  if (/^0+\.0{2}$/.test(amount)) return null;
  return amount;
}

function normalizeOrderId(value: string): string | null {
  const sourceOrderId = value.trim();
  if (
    !sourceOrderId ||
    sourceOrderId.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(sourceOrderId)
  ) return null;
  return sourceOrderId;
}

function isAllowedInput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["sourceOrderId", "amount", "currency", "successUrl", "cancelUrl", "referralToken"]);
  return keys.every((key) => allowed.has(key));
}

function normalizeInput(value: unknown): CommerceCheckoutInput | null {
  if (!isAllowedInput(value)) return null;
  const source = value;
  if (
    typeof source.sourceOrderId !== "string" ||
    typeof source.amount !== "string" ||
    typeof source.currency !== "string" ||
    typeof source.successUrl !== "string" ||
    typeof source.cancelUrl !== "string" ||
    (source.referralToken !== undefined && typeof source.referralToken !== "string")
  ) return null;

  const sourceOrderId = normalizeOrderId(source.sourceOrderId);
  const amount = normalizeAmount(source.amount);
  const currency = source.currency.trim().toLowerCase();
  if (!sourceOrderId || !amount || !/^[a-z]{3}$/.test(currency)) return null;

  const [successUrl, cancelUrl] = [normalizeHttpsUrl(source.successUrl), normalizeHttpsUrl(source.cancelUrl)];
  if (!successUrl || !cancelUrl) return null;

  const referralToken = typeof source.referralToken === "string" ? source.referralToken.trim() : undefined;
  if (referralToken !== undefined && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(referralToken)) {
    return null;
  }
  return {
    sourceOrderId,
    amount,
    currency,
    successUrl,
    cancelUrl,
    ...(referralToken ? { referralToken } : {}),
  };
}

function requestDigest(input: CommerceCheckoutInput): string {
  const canonical = JSON.stringify([
    input.sourceOrderId,
    input.amount,
    input.currency,
    input.successUrl,
    input.cancelUrl,
    input.referralToken ?? null,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeHttpsUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return null;
  return url.toString();
}

async function validatePublicDestinations(input: CommerceCheckoutInput): Promise<CommerceCheckoutInput | null> {
  const [successUrl, cancelUrl] = await Promise.all([
    publicHttpsUrl(input.successUrl),
    publicHttpsUrl(input.cancelUrl),
  ]);
  if (!successUrl || !cancelUrl) return null;
  return { ...input, successUrl, cancelUrl };
}

function existingResult(checkout: {
  idempotencyDigest: string;
  hostedCheckoutUrl: string | null;
  hostedCheckoutRef: string | null;
  alternateCheckoutRef: string | null;
  status: string;
  nextAttemptAt: Date | null;
}, digest: string, now: Date): ClaimResult | null {
  if (checkout.idempotencyDigest !== digest) return { kind: "conflict" };
  if (checkout.alternateCheckoutRef) return { kind: "uncertain" };
  if (checkout.hostedCheckoutRef && !checkout.hostedCheckoutUrl) return { kind: "uncertain" };
  if (checkout.hostedCheckoutUrl) {
    return {
      kind: "ready",
      checkoutUrl: checkout.hostedCheckoutUrl,
      checkoutRef: checkout.hostedCheckoutRef,
    };
  }
  if (checkout.nextAttemptAt && checkout.nextAttemptAt > now) {
    if (checkout.status === "CREATING" || checkout.status === "RETRYABLE") {
      return { kind: "accepted", retryAt: checkout.nextAttemptAt };
    }
  }
  if (checkout.status === "RETRYABLE") return null;
  // A prior release used FAILED as a retryable state for every provider error,
  // including timeouts after the provider may have created an invoice. Treat
  // it, expired claims, and unknown states as requiring reconciliation.
  if (checkout.status === "CREATING") return null;
  return { kind: "uncertain" };
}

async function readExisting(merchantId: string, sourceOrderId: string, digest: string): Promise<ClaimResult | null> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.CommerceCheckout.id}
      FROM ${SqlSchema.tables.CommerceCheckout.name}
      WHERE ${SqlSchema.tables.CommerceCheckout.merchantId} = ${merchantId}
        AND ${SqlSchema.tables.CommerceCheckout.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
        AND ${SqlSchema.tables.CommerceCheckout.sourceOrderId} = ${sourceOrderId}
      FOR UPDATE
    `);
    if (!locked[0]) return null;

    const checkout = await tx.commerceCheckout.findUnique({
      where: { id: locked[0].id },
      select: {
        id: true,
        idempotencyDigest: true,
        hostedCheckoutUrl: true,
        hostedCheckoutRef: true,
        alternateCheckoutRef: true,
        status: true,
        nextAttemptAt: true,
        attempts: true,
      },
    });
    if (!checkout) return null;

    if (
      (checkout.alternateCheckoutRef || (checkout.hostedCheckoutRef && !checkout.hostedCheckoutUrl)) &&
      checkout.status !== "UNCERTAIN"
    ) {
      await tx.commerceCheckout.updateMany({
        where: {
          id: checkout.id,
          hostedCheckoutRef: checkout.hostedCheckoutRef,
          alternateCheckoutRef: checkout.alternateCheckoutRef,
        },
        data: {
          status: "UNCERTAIN",
          hostedCheckoutUrl: null,
          lastCreationError: "Multiple provider invoice references require reconciliation",
          nextAttemptAt: null,
        },
      });
      return { kind: "uncertain" };
    }

    const result = existingResult(checkout, digest, now);
    if (result) return result;

    if (checkout.status === "RETRYABLE") return null;

    // An expired CREATING lease only says the caller stopped hearing from the
    // provider. It does not prove the invoice was not created.
    await tx.commerceCheckout.updateMany({
      where: { id: checkout.id, status: "CREATING", attempts: checkout.attempts },
      data: {
        status: "UNCERTAIN",
        lastCreationError: "Provider outcome requires reconciliation",
        nextAttemptAt: null,
      },
    });
    return { kind: "uncertain" };
  });
}

async function claimCheckout(input: {
  merchantId: string;
  connectionId: string;
  checkout: CommerceCheckoutInput;
  clickId: string | null;
  digest: string;
}, retry = false): Promise<ClaimResult> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + CHECKOUT_LEASE_MS);
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT ${SqlSchema.tables.CommerceCheckout.id}
        FROM ${SqlSchema.tables.CommerceCheckout.name}
        WHERE ${SqlSchema.tables.CommerceCheckout.merchantId} = ${input.merchantId}
          AND ${SqlSchema.tables.CommerceCheckout.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
          AND ${SqlSchema.tables.CommerceCheckout.sourceOrderId} = ${input.checkout.sourceOrderId}
        FOR UPDATE
      `);
      if (locked[0]) {
        const existing = await tx.commerceCheckout.findUnique({
          where: { id: locked[0].id },
          select: {
            id: true,
            idempotencyDigest: true,
            hostedCheckoutUrl: true,
            hostedCheckoutRef: true,
            alternateCheckoutRef: true,
            status: true,
            nextAttemptAt: true,
            attempts: true,
          },
        });
        if (!existing) throw new Error("Checkout disappeared");
        if (
          (existing.alternateCheckoutRef || (existing.hostedCheckoutRef && !existing.hostedCheckoutUrl)) &&
          existing.status !== "UNCERTAIN"
        ) {
          await tx.commerceCheckout.updateMany({
            where: {
              id: existing.id,
              hostedCheckoutRef: existing.hostedCheckoutRef,
              alternateCheckoutRef: existing.alternateCheckoutRef,
            },
            data: {
              status: "UNCERTAIN",
              hostedCheckoutUrl: null,
              lastCreationError: "Multiple provider invoice references require reconciliation",
              nextAttemptAt: null,
            },
          });
          return { kind: "uncertain" };
        }
        const result = existingResult(existing, input.digest, now);
        if (result) return result;
        if (existing.status === "RETRYABLE") {
          const claimed = await tx.commerceCheckout.updateMany({
            where: { id: existing.id, status: "RETRYABLE", attempts: existing.attempts },
            data: {
              connectionId: input.connectionId,
              clickId: input.clickId,
              amount: new Prisma.Decimal(input.checkout.amount),
              currency: input.checkout.currency,
              successUrl: input.checkout.successUrl,
              cancelUrl: input.checkout.cancelUrl,
              status: "CREATING",
              attempts: { increment: 1 },
              lastCreationError: null,
              nextAttemptAt: leaseUntil,
            },
          });
          return claimed.count === 1
            ? { kind: "claimed", checkoutId: existing.id, attempts: existing.attempts + 1 }
            : { kind: "uncertain" };
        }
        await tx.commerceCheckout.updateMany({
          where: { id: existing.id, status: "CREATING", attempts: existing.attempts },
          data: {
            status: "UNCERTAIN",
            lastCreationError: "Provider outcome requires reconciliation",
            nextAttemptAt: null,
          },
        });
        return { kind: "uncertain" };
      }

      const created = await tx.commerceCheckout.create({
        data: {
          merchantId: input.merchantId,
          connectionId: input.connectionId,
          provider: CHECKOUT_PROVIDER,
          sourceOrderId: input.checkout.sourceOrderId,
          clickId: input.clickId,
          amount: new Prisma.Decimal(input.checkout.amount),
          currency: input.checkout.currency,
          successUrl: input.checkout.successUrl,
          cancelUrl: input.checkout.cancelUrl,
          idempotencyDigest: input.digest,
          status: "CREATING",
          attempts: 1,
          nextAttemptAt: leaseUntil,
        },
        select: { id: true, attempts: true },
      });
      return { kind: "claimed", checkoutId: created.id, attempts: created.attempts };
    });
  } catch (error) {
    if (!retry && isUniqueConstraintError(error)) {
      return claimCheckout(input, true);
    }
    throw error;
  }
}

async function persistUncertain(
  checkoutId: string,
  attempts: number,
  providerRef: string | null = null
): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ attempts: number; status: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.CommerceCheckout.attempts}, ${SqlSchema.tables.CommerceCheckout.status}
      FROM ${SqlSchema.tables.CommerceCheckout.name}
      WHERE ${SqlSchema.tables.CommerceCheckout.id} = ${checkoutId}
      FOR UPDATE
    `);
    const checkout = rows[0];
    if (!checkout) return;
    if (providerRef) {
      await recordCommerceCheckoutReference(tx, checkoutId, providerRef, true);
      return;
    }
    if (checkout.status === "CREATING" && checkout.attempts === attempts) {
      await tx.commerceCheckout.updateMany({
        where: { id: checkoutId, status: "CREATING", attempts },
        data: {
          status: "UNCERTAIN",
          hostedCheckoutUrl: null,
          lastCreationError: "Provider outcome requires reconciliation",
          nextAttemptAt: null,
        },
      });
    }
  });
}

function retryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

async function persistDefiniteRejection(checkoutId: string, attempts: number): Promise<Date | null> {
  const retryAt = new Date(Date.now() + retryDelay(attempts));
  const updated = await db.commerceCheckout.updateMany({
    where: {
      id: checkoutId,
      status: "CREATING",
      attempts,
      hostedCheckoutRef: null,
      alternateCheckoutRef: null,
    },
    data: {
      status: "RETRYABLE",
      hostedCheckoutUrl: null,
      lastCreationError: "Provider rejected the request before creating an invoice",
      nextAttemptAt: retryAt,
    },
  });
  return updated.count === 1 ? retryAt : null;
}

/** Return only the merchant's unresolved rows and only fields safe for the settings UI. */
export async function getUncertainCommerceCheckouts(
  ownerId: string,
  merchantId: string,
  requestedPage: number
): Promise<UncertainCommerceCheckoutPage> {
  const pageSize = 50;
  const where = {
    merchantId,
    provider: CHECKOUT_PROVIDER,
    status: "UNCERTAIN",
    merchant: { ownerId },
  } as const;
  const totalCount = await db.commerceCheckout.count({ where });
  const pageCount = Math.ceil(totalCount / pageSize);
  const requested = Number.isSafeInteger(requestedPage) ? Math.max(0, requestedPage) : 0;
  const page = Math.min(requested, Math.max(0, pageCount - 1));
  const rows = totalCount === 0 ? [] : await db.commerceCheckout.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: page * pageSize,
    take: pageSize,
    select: {
      id: true,
      sourceOrderId: true,
      amount: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
      hostedCheckoutRef: true,
      alternateCheckoutRef: true,
    },
  });
  return {
    checkouts: rows.map((row) => ({
      id: row.id,
      sourceOrderId: row.sourceOrderId,
      amount: row.amount.toFixed(2),
      currency: row.currency,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      primaryInvoiceRef: row.hostedCheckoutRef,
      alternateInvoiceRef: row.alternateCheckoutRef,
    })),
    page,
    pageCount,
    totalCount,
  };
}

function normalizeFoundInvoice(invoiceRefValue: string, invoiceUrlValue: string): {
  invoiceRef: string;
  invoiceUrl: string;
} | null {
  const invoiceRef = invoiceRefValue.trim();
  if (!/^[a-z\d_-]{1,128}$/i.test(invoiceRef)) return null;

  let invoiceUrl: URL;
  try {
    invoiceUrl = new URL(invoiceUrlValue.trim());
  } catch {
    return null;
  }
  const hostname = invoiceUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (
    invoiceUrl.protocol !== "https:" ||
    !["nowpayments.io", "www.nowpayments.io"].includes(hostname) ||
    (invoiceUrl.port !== "" && invoiceUrl.port !== "443") ||
    invoiceUrl.username ||
    invoiceUrl.password ||
    invoiceUrl.hash
  ) return null;
  const queryInvoiceRefs = invoiceUrl.searchParams.getAll("iid");
  if (queryInvoiceRefs.length !== 1 || queryInvoiceRefs[0] !== invoiceRef) return null;
  return { invoiceRef, invoiceUrl: invoiceUrl.toString() };
}

async function lockOwnedUncertainCheckout(
  tx: Prisma.TransactionClient,
  ownerId: string,
  merchantId: string,
  checkoutId: string
): Promise<{
  id: string;
  sourceOrderId: string;
  hostedCheckoutRef: string | null;
  alternateCheckoutRef: string | null;
  updatedAt: Date;
} | null> {
  const rows = await tx.$queryRaw<{
    id: string;
    sourceOrderId: string;
    hostedCheckoutRef: string | null;
    alternateCheckoutRef: string | null;
    updatedAt: Date;
  }[]>(Prisma.sql`
    SELECT checkout.${SqlSchema.tables.CommerceCheckout.id},
      checkout.${SqlSchema.tables.CommerceCheckout.sourceOrderId},
      checkout.${SqlSchema.tables.CommerceCheckout.hostedCheckoutRef},
      checkout.${SqlSchema.tables.CommerceCheckout.alternateCheckoutRef},
      checkout.${SqlSchema.tables.CommerceCheckout.updatedAt}
    FROM ${SqlSchema.tables.CommerceCheckout.name} AS checkout
    INNER JOIN ${SqlSchema.tables.Merchant.name} AS merchant
      ON merchant.${SqlSchema.tables.Merchant.id} = checkout.${SqlSchema.tables.CommerceCheckout.merchantId}
    WHERE checkout.${SqlSchema.tables.CommerceCheckout.id} = ${checkoutId}
      AND checkout.${SqlSchema.tables.CommerceCheckout.merchantId} = ${merchantId}
      AND merchant.${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      AND checkout.${SqlSchema.tables.CommerceCheckout.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
      AND checkout.${SqlSchema.tables.CommerceCheckout.status} = 'UNCERTAIN'
    FOR UPDATE OF checkout
  `);
  return rows[0] ?? null;
}

async function queueTerminalCheckoutResolution(
  tx: Prisma.TransactionClient,
  merchantId: string,
  checkout: { id: string; sourceOrderId: string },
  invoiceRef: string
): Promise<{
  unappliedRefund: boolean;
  terminalSnapshot: {
    paymentRef: string;
    invoiceRef: string | null;
    status: string;
    saleAmount: string;
    saleCurrency: string;
    cryptoAmount: string | null;
    cryptoCurrency: string | null;
    cryptoNetwork: string | null;
  } | null;
}> {
  const payment = await tx.paymentRecord.findUnique({
    where: {
      merchantId_provider_sourceOrderId: {
        merchantId,
        provider: CHECKOUT_PROVIDER,
        sourceOrderId: checkout.sourceOrderId,
      },
    },
    select: {
      id: true,
      paymentRef: true,
      status: true,
    },
  });
  const nullInvoicePaymentMatch = payment?.paymentRef
    ? Prisma.sql`AND w.${SqlSchema.tables.WebhookEvent.payload}->>'paymentRef' = ${payment.paymentRef}`
    : Prisma.sql`AND FALSE`;

  const terminalEvents = await tx.$queryRaw<{
    providerEventId: string;
    payload: Prisma.JsonValue;
  }[]>(Prisma.sql`
    SELECT w.${SqlSchema.tables.WebhookEvent.providerEventId}, w.${SqlSchema.tables.WebhookEvent.payload}
    FROM ${SqlSchema.tables.WebhookEvent.name} AS w
    WHERE w.${SqlSchema.tables.WebhookEvent.merchantId} = ${merchantId}
      AND w.${SqlSchema.tables.WebhookEvent.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
      AND w.${SqlSchema.tables.WebhookEvent.status} IN (
        'PENDING'::${SqlSchema.types.WebhookEventStatus},
        'PROCESSING'::${SqlSchema.types.WebhookEventStatus},
        'PROCESSED'::${SqlSchema.types.WebhookEventStatus},
        'FAILED'::${SqlSchema.types.WebhookEventStatus}
      )
      AND w.${SqlSchema.tables.WebhookEvent.payload}->>'provider' = ${PaymentProvider.NOWPAYMENTS.id}
      AND w.${SqlSchema.tables.WebhookEvent.payload}->>'eventId' = w.${SqlSchema.tables.WebhookEvent.providerEventId}
      AND w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'order_id' = ${checkout.sourceOrderId}
      AND (
        w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'invoice_id' = ${invoiceRef}
        OR (
          COALESCE(w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'invoice_id', '') = ''
          ${nullInvoicePaymentMatch}
        )
      )
      AND lower(w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'payment_status') IN ('finished', 'refunded')
    ORDER BY CASE WHEN w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'invoice_id' = ${invoiceRef} THEN 0 ELSE 1 END,
      CASE lower(w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'payment_status')
      WHEN 'refunded' THEN 0 ELSE 1 END, w.${SqlSchema.tables.WebhookEvent.createdAt} DESC
    LIMIT 50
  `);

  const validEvents: { original: Prisma.JsonObject; paymentRef: string; status: string; invoiceRef: string | null }[] = [];
  for (const candidate of terminalEvents) {
    if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) continue;
    const original = candidate.payload as Prisma.JsonObject;
    const originalRaw = original.rawPayload;
    if (!originalRaw || typeof originalRaw !== "object" || Array.isArray(originalRaw)) continue;
    const raw = originalRaw as Prisma.JsonObject;
    const providerStatus = raw.payment_status;
    const paymentRef = original.paymentRef;
    const rawPaymentRef = typeof raw.payment_id === "string"
      ? raw.payment_id
      : typeof raw.payment_id === "number" && Number.isSafeInteger(raw.payment_id)
        ? String(raw.payment_id)
        : null;
    const rawInvoiceRef = typeof raw.invoice_id === "string"
      ? raw.invoice_id
      : typeof raw.invoice_id === "number" && Number.isSafeInteger(raw.invoice_id)
        ? String(raw.invoice_id)
        : null;
    const baseEventIdMatches = original.eventId === `${paymentRef}:${providerStatus}`;
    const reconciliationEventIdMatches =
      original.reconciliation === true &&
      typeof original.eventId === "string" &&
      /^owner-reconcile:[a-f0-9]{64}$/.test(original.eventId);
    if (
      typeof providerStatus !== "string" ||
      !["finished", "refunded"].includes(providerStatus.toLowerCase()) ||
      typeof paymentRef !== "string" ||
      !paymentRef.trim() ||
      rawPaymentRef !== paymentRef ||
      (rawInvoiceRef !== null && rawInvoiceRef !== invoiceRef) ||
      raw.order_id !== checkout.sourceOrderId ||
      original.provider !== PaymentProvider.NOWPAYMENTS.id ||
      original.eventId !== candidate.providerEventId ||
      (!baseEventIdMatches && !reconciliationEventIdMatches) ||
      typeof original.kind !== "string" ||
      typeof original.saleAmount !== "string" ||
      typeof original.saleCurrency !== "string" ||
      typeof original.occurredAt !== "string" ||
      Number.isNaN(new Date(original.occurredAt).getTime())
    ) continue;
    if (rawInvoiceRef === null && (!payment?.paymentRef || payment.paymentRef !== paymentRef)) continue;
    validEvents.push({ original, paymentRef, status: providerStatus.toLowerCase(), invoiceRef: rawInvoiceRef });
  }
  const explicitInvoiceEvents = validEvents.filter((event) => event.invoiceRef === invoiceRef);
  const fallbackInvoiceEvents = validEvents.filter((event) => event.invoiceRef === null);
  const selectedInvoiceEvents = explicitInvoiceEvents.length > 0
    ? explicitInvoiceEvents
    : fallbackInvoiceEvents;
  const knownPaymentRef = explicitInvoiceEvents[0]?.paymentRef ??
    payment?.paymentRef ??
    fallbackInvoiceEvents[0]?.paymentRef;
  if (!knownPaymentRef) return { unappliedRefund: false, terminalSnapshot: null };
  const matchingEvents = selectedInvoiceEvents.filter((event) => event.paymentRef === knownPaymentRef);
  let unappliedRefund = false;
  const byStatus = new Map<string, Prisma.JsonObject>();
  for (const event of matchingEvents) {
    const samePaymentRecord = payment?.paymentRef === event.paymentRef;
    if (event.status === "refunded" && (!samePaymentRecord || payment?.status.toLowerCase() !== "refunded")) {
      unappliedRefund = true;
    }
    if (!byStatus.has(event.status)) byStatus.set(event.status, event.original);
  }

  const selectedTerminal = matchingEvents.find((event) => event.status === "refunded") ??
    matchingEvents.find((event) => event.status === "finished");
  const storedStatus = payment && payment.paymentRef === knownPaymentRef
    ? payment.status.toLowerCase()
    : undefined;
  const terminalStatus = storedStatus === "refunded" || storedStatus === "finished"
    ? storedStatus
    : selectedTerminal?.status ?? storedStatus ?? "finished";
  const snapshotPayload = selectedTerminal?.original;
  const snapshotRaw = snapshotPayload?.rawPayload;
  const terminalSnapshot =
    snapshotPayload &&
    typeof snapshotPayload.saleAmount === "string" &&
    typeof snapshotPayload.saleCurrency === "string" &&
    snapshotRaw &&
    typeof snapshotRaw === "object" &&
    !Array.isArray(snapshotRaw)
    ? {
        paymentRef: knownPaymentRef,
        invoiceRef: selectedTerminal.invoiceRef,
        status: terminalStatus,
        saleAmount: snapshotPayload.saleAmount,
        saleCurrency: snapshotPayload.saleCurrency,
        cryptoAmount: typeof snapshotPayload.cryptoAmount === "string" ? snapshotPayload.cryptoAmount : null,
        cryptoCurrency: typeof snapshotPayload.cryptoCurrency === "string" ? snapshotPayload.cryptoCurrency : null,
        cryptoNetwork: typeof (snapshotRaw as Prisma.JsonObject).network === "string"
          ? String((snapshotRaw as Prisma.JsonObject).network).toLowerCase()
          : null,
      }
    : null;

  for (const [status, original] of byStatus) {
    const originalRaw = original.rawPayload as Prisma.InputJsonObject;
    const reconciliationEventId = `owner-reconcile:${createHash("sha256")
      .update(`${checkout.id}\0${knownPaymentRef}\0${status}\0${invoiceRef}`, "utf8")
      .digest("hex")}`;
    const payload = {
      ...(original as unknown as Prisma.InputJsonObject),
      eventId: reconciliationEventId,
      reconciliation: true,
      checkoutRef: invoiceRef,
      rawPayload: { ...originalRaw, invoice_id: invoiceRef },
    } satisfies Prisma.InputJsonObject;

    const existing = await tx.webhookEvent.findUnique({
      where: {
        merchantId_provider_providerEventId: {
          merchantId,
          provider: CHECKOUT_PROVIDER,
          providerEventId: reconciliationEventId,
        },
      },
      select: { id: true, status: true },
    });
    if (!existing) {
      await tx.webhookEvent.create({
        data: {
          merchantId,
          provider: CHECKOUT_PROVIDER,
          providerEventId: reconciliationEventId,
          payload,
        },
      });
    } else if (existing.status === "FAILED" || existing.status === "PROCESSED") {
      await tx.webhookEvent.updateMany({
        where: { id: existing.id, status: existing.status },
        data: { status: "PENDING", attempts: 0, lastError: null, nextAttemptAt: new Date(), processedAt: null },
      });
    }
  }
  return { unappliedRefund, terminalSnapshot };
}

/** Attach an invoice the owner located in the provider dashboard to its order. */
export async function reconcileCommerceCheckoutAsFound(
  ownerId: string,
  merchantId: string,
  checkoutId: string,
  invoiceRefValue: string,
  invoiceUrlValue: string
): Promise<void> {
  const normalized = normalizeFoundInvoice(invoiceRefValue, invoiceUrlValue);
  if (!normalized || !(await publicHttpsUrl(normalized.invoiceUrl))) {
    throw new Error("Enter a valid NOWPayments invoice ID and hosted invoice URL.");
  }

  await db.$transaction(async (tx) => {
    const checkout = await lockOwnedUncertainCheckout(tx, ownerId, merchantId, checkoutId);
    if (!checkout) throw new Error("This checkout is no longer available for reconciliation.");
    const updated = await tx.commerceCheckout.updateMany({
      where: { id: checkout.id, merchantId, status: "UNCERTAIN", attempts: { gt: 0 } },
      data: {
        hostedCheckoutRef: normalized.invoiceRef,
        alternateCheckoutRef: null,
        hostedCheckoutUrl: normalized.invoiceUrl,
        status: "READY",
        lastCreationError: null,
        nextAttemptAt: null,
        reconciliationResolution: "FOUND",
        reconciledAt: new Date(),
        reconciledByOwnerId: ownerId,
      },
    });
    if (updated.count !== 1) throw new Error("This checkout is no longer available for reconciliation.");
    const replay = await queueTerminalCheckoutResolution(tx, merchantId, checkout, normalized.invoiceRef);
    await tx.commerceCheckout.update({
      where: { id: checkout.id },
      data: { refundReconciliationPendingAt: replay.unappliedRefund ? new Date() : null },
    });
    if (replay.unappliedRefund) {
      await holdUnpaidCheckoutCommissions(tx, checkout.id);
      await holdCheckoutDeliveries(tx, merchantId, checkout.sourceOrderId);
    }
  });
}

/** Allow one later retry only after a merchant checks the provider invoice list. */
export async function reconcileCommerceCheckoutAsAbsent(
  ownerId: string,
  merchantId: string,
  checkoutId: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const checkout = await lockOwnedUncertainCheckout(tx, ownerId, merchantId, checkoutId);
    if (!checkout) throw new Error("This checkout is no longer available for reconciliation.");
    if (checkout.hostedCheckoutRef || checkout.alternateCheckoutRef) {
      throw new Error("A provider invoice reference is already recorded. Reconcile that invoice instead.");
    }
    const retryEligibleAt = checkout.updatedAt.getTime() + CHECKOUT_LEASE_MS + RECONCILIATION_GRACE_MS;
    if (Date.now() < retryEligibleAt) {
      throw new Error("Wait 15 minutes from the last update before confirming that no invoice exists.");
    }
    const updated = await tx.commerceCheckout.updateMany({
      where: {
        id: checkout.id,
        merchantId,
        status: "UNCERTAIN",
        hostedCheckoutRef: null,
        alternateCheckoutRef: null,
        attempts: { gt: 0 },
      },
      data: {
        status: "RETRYABLE",
        nextAttemptAt: new Date(),
        lastCreationError: "Owner confirmed no provider invoice was found",
        reconciliationResolution: "CONFIRMED_ABSENT",
        reconciledAt: new Date(),
        reconciledByOwnerId: ownerId,
      },
    });
    if (updated.count !== 1) throw new Error("This checkout is no longer available for reconciliation.");
  });
}

/** Validate, claim and create one provider checkout for a signed commerce order. */
export async function createCommerceCheckout(
  merchantId: string,
  candidate: unknown
): Promise<CommerceCheckoutResult> {
  const normalized = normalizeInput(candidate);
  if (!normalized) return { kind: "invalid" };

  const digest = requestDigest(normalized);
  const known = await readExisting(merchantId, normalized.sourceOrderId, digest);
  if (known && known.kind !== "claimed") return known;

  const input = await validatePublicDestinations(normalized);
  if (!input) return { kind: "invalid" };

  let clickId: string | null = null;
  if (input.referralToken) {
    const click = await db.click.findUnique({
      where: { referralToken: input.referralToken },
      select: { id: true, merchantId: true, expiresAt: true },
    });
    if (!click || click.merchantId !== merchantId || click.expiresAt <= new Date()) {
      return { kind: "invalid" };
    }
    clickId = click.id;
  }

  const connection = await getNowPaymentsCheckoutConnection(merchantId);
  if (!connection?.connectionId || !connection.callbackUrl) return { kind: "unavailable" };
  const callbackUrl = await publicHttpsUrl(connection.callbackUrl);
  if (!callbackUrl) return { kind: "unavailable" };

  const adapter = getPaymentProviderAdapter(PaymentProvider.NOWPAYMENTS.id);
  if (!adapter?.createCheckout) return { kind: "unavailable" };
  const claim = await claimCheckout({
    merchantId,
    connectionId: connection.connectionId,
    checkout: input,
    clickId,
    digest,
  });
  if (claim.kind !== "claimed") return claim;

  let hosted: { checkoutRef: string; checkoutUrl: string };
  try {
    hosted = await adapter.createCheckout(
      {
        amount: input.amount,
        currency: input.currency,
        sourceOrderId: input.sourceOrderId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        callbackUrl,
      },
      connection
    );
  } catch (error) {
    // Some provider errors are explicit rejections received before an invoice
    // could be created. Network and server failures remain uncertain.
    if (error instanceof CheckoutProviderError && error.outcome === "rejected") {
      const retryAt = await persistDefiniteRejection(claim.checkoutId, claim.attempts);
      if (retryAt) return { kind: "accepted", retryAt };
      return { kind: "uncertain" };
    }
    await persistUncertain(
      claim.checkoutId,
      claim.attempts,
      error instanceof CheckoutProviderError ? error.providerRef ?? null : null
    );
    return { kind: "uncertain" };
  }

  const checkoutUrl = await publicHttpsUrl(hosted.checkoutUrl);
  if (!checkoutUrl) {
    await persistUncertain(claim.checkoutId, claim.attempts, hosted.checkoutRef);
    return { kind: "uncertain" };
  }

  return db.$transaction(async (tx): Promise<CommerceCheckoutResult> => {
    const rows = await tx.$queryRaw<{
      attempts: number;
      status: string;
      hostedCheckoutUrl: string | null;
      hostedCheckoutRef: string | null;
      alternateCheckoutRef: string | null;
    }[]>(Prisma.sql`
      SELECT
        ${SqlSchema.tables.CommerceCheckout.attempts},
        ${SqlSchema.tables.CommerceCheckout.status},
        ${SqlSchema.tables.CommerceCheckout.hostedCheckoutUrl},
        ${SqlSchema.tables.CommerceCheckout.hostedCheckoutRef},
        ${SqlSchema.tables.CommerceCheckout.alternateCheckoutRef}
      FROM ${SqlSchema.tables.CommerceCheckout.name}
      WHERE ${SqlSchema.tables.CommerceCheckout.id} = ${claim.checkoutId}
      FOR UPDATE
    `);
    const checkout = rows[0];
    if (!checkout) return { kind: "uncertain" };

    if (
      checkout.attempts === claim.attempts &&
      checkout.status === "READY" &&
      checkout.hostedCheckoutUrl &&
      checkout.hostedCheckoutRef === hosted.checkoutRef &&
      checkout.alternateCheckoutRef === null
    ) {
      return {
        kind: "ready",
        checkoutUrl: checkout.hostedCheckoutUrl,
        checkoutRef: checkout.hostedCheckoutRef,
      };
    }

    if (
      checkout.alternateCheckoutRef ||
      (checkout.hostedCheckoutRef && checkout.hostedCheckoutRef !== hosted.checkoutRef) ||
      checkout.attempts !== claim.attempts ||
      !["CREATING", "UNCERTAIN"].includes(checkout.status)
    ) {
      await recordCommerceCheckoutReference(tx, claim.checkoutId, hosted.checkoutRef, true);
      return { kind: "uncertain" };
    }

    const updated = await tx.commerceCheckout.updateMany({
      where: {
        id: claim.checkoutId,
        attempts: claim.attempts,
        status: { in: ["CREATING", "UNCERTAIN"] },
        hostedCheckoutUrl: null,
        alternateCheckoutRef: null,
        OR: [
          { hostedCheckoutRef: null },
          { hostedCheckoutRef: hosted.checkoutRef },
        ],
      },
      data: {
        hostedCheckoutRef: hosted.checkoutRef,
        hostedCheckoutUrl: checkoutUrl,
        status: "READY",
        lastCreationError: null,
        nextAttemptAt: null,
      },
    });
    if (updated.count === 1) {
      const replay = await queueTerminalCheckoutResolution(
        tx,
        merchantId,
        { id: claim.checkoutId, sourceOrderId: input.sourceOrderId },
        hosted.checkoutRef
      );
      await tx.commerceCheckout.update({
        where: { id: claim.checkoutId },
        data: { refundReconciliationPendingAt: replay.unappliedRefund ? new Date() : null },
      });
      if (replay.unappliedRefund) {
        await holdUnpaidCheckoutCommissions(tx, claim.checkoutId);
        await holdCheckoutDeliveries(tx, merchantId, input.sourceOrderId);
      }
      return { kind: "ready", checkoutUrl, checkoutRef: hosted.checkoutRef };
    }

    const settled = await tx.commerceCheckout.findUnique({
      where: { id: claim.checkoutId },
      select: {
        attempts: true,
        status: true,
        hostedCheckoutUrl: true,
        hostedCheckoutRef: true,
        alternateCheckoutRef: true,
      },
    });
    if (
      settled?.attempts === claim.attempts &&
      settled.hostedCheckoutUrl &&
      settled.status === "READY" &&
      settled.hostedCheckoutRef === hosted.checkoutRef &&
      settled.alternateCheckoutRef === null
    ) {
      return { kind: "ready", checkoutUrl: settled.hostedCheckoutUrl, checkoutRef: settled.hostedCheckoutRef };
    }
    await recordCommerceCheckoutReference(tx, claim.checkoutId, hosted.checkoutRef, true);
    return { kind: "uncertain" };
  });
}
