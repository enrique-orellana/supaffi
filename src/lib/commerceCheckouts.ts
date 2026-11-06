import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getNowPaymentsCheckoutConnection } from "@/lib/paymentConnections";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import { CheckoutProviderError } from "@/lib/payments/types";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";

const CHECKOUT_PROVIDER = "NOWPAYMENTS" as const;
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
  possibleInvoiceRef: string | null;
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
  status: string;
  nextAttemptAt: Date | null;
}, digest: string, now: Date): ClaimResult | null {
  if (checkout.idempotencyDigest !== digest) return { kind: "conflict" };
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
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CommerceCheckout"
      WHERE "merchantId" = ${merchantId}
        AND "provider" = 'NOWPAYMENTS'::"PaymentProvider"
        AND "sourceOrderId" = ${sourceOrderId}
      FOR UPDATE
    `;
    if (!locked[0]) return null;

    const checkout = await tx.commerceCheckout.findUnique({
      where: { id: locked[0].id },
      select: {
        id: true,
        idempotencyDigest: true,
        hostedCheckoutUrl: true,
        hostedCheckoutRef: true,
        status: true,
        nextAttemptAt: true,
        attempts: true,
      },
    });
    if (!checkout) return null;

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
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "CommerceCheckout"
        WHERE "merchantId" = ${input.merchantId}
          AND "provider" = 'NOWPAYMENTS'::"PaymentProvider"
          AND "sourceOrderId" = ${input.checkout.sourceOrderId}
        FOR UPDATE
      `;
      if (locked[0]) {
        const existing = await tx.commerceCheckout.findUnique({
          where: { id: locked[0].id },
          select: {
            id: true,
            idempotencyDigest: true,
            hostedCheckoutUrl: true,
            hostedCheckoutRef: true,
            status: true,
            nextAttemptAt: true,
            attempts: true,
          },
        });
        if (!existing) throw new Error("Checkout disappeared");
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
  await db.commerceCheckout.updateMany({
    where: { id: checkoutId, status: "CREATING", attempts },
    data: {
      status: "UNCERTAIN",
      hostedCheckoutRef: providerRef,
      hostedCheckoutUrl: null,
      lastCreationError: "Provider outcome requires reconciliation",
      nextAttemptAt: null,
    },
  });
}

function retryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

async function persistDefiniteRejection(checkoutId: string, attempts: number): Promise<Date | null> {
  const retryAt = new Date(Date.now() + retryDelay(attempts));
  const updated = await db.commerceCheckout.updateMany({
    where: { id: checkoutId, status: "CREATING", attempts },
    data: {
      status: "RETRYABLE",
      hostedCheckoutRef: null,
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
      possibleInvoiceRef: row.hostedCheckoutRef,
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
): Promise<{ id: string; hostedCheckoutRef: string | null; updatedAt: Date } | null> {
  const rows = await tx.$queryRaw<{ id: string; hostedCheckoutRef: string | null; updatedAt: Date }[]>`
    SELECT checkout."id", checkout."hostedCheckoutRef", checkout."updatedAt"
    FROM "CommerceCheckout" AS checkout
    INNER JOIN "Merchant" AS merchant ON merchant."id" = checkout."merchantId"
    WHERE checkout."id" = ${checkoutId}
      AND checkout."merchantId" = ${merchantId}
      AND merchant."ownerId" = ${ownerId}
      AND checkout."provider" = 'NOWPAYMENTS'::"PaymentProvider"
      AND checkout."status" = 'UNCERTAIN'
    FOR UPDATE OF checkout
  `;
  return rows[0] ?? null;
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
    if (checkout.hostedCheckoutRef && checkout.hostedCheckoutRef !== normalized.invoiceRef) {
      throw new Error("The invoice ID does not match the provider reference already recorded.");
    }
    const updated = await tx.commerceCheckout.updateMany({
      where: { id: checkout.id, merchantId, status: "UNCERTAIN", attempts: { gt: 0 } },
      data: {
        hostedCheckoutRef: normalized.invoiceRef,
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
    if (checkout.hostedCheckoutRef) {
      throw new Error("A provider invoice reference is already recorded. Reconcile that invoice instead.");
    }
    const retryEligibleAt = checkout.updatedAt.getTime() + CHECKOUT_LEASE_MS + RECONCILIATION_GRACE_MS;
    if (Date.now() < retryEligibleAt) {
      throw new Error("Wait 15 minutes from the last update before confirming that no invoice exists.");
    }
    const updated = await tx.commerceCheckout.updateMany({
      where: { id: checkout.id, merchantId, status: "UNCERTAIN", hostedCheckoutRef: null, attempts: { gt: 0 } },
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

  const adapter = getPaymentProviderAdapter("nowpayments");
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

  const updated = await db.commerceCheckout.updateMany({
    where: {
      id: claim.checkoutId,
      attempts: claim.attempts,
      status: { in: ["CREATING", "UNCERTAIN"] },
      hostedCheckoutUrl: null,
    },
    data: {
      hostedCheckoutRef: hosted.checkoutRef,
      hostedCheckoutUrl: checkoutUrl,
      status: "READY",
      lastCreationError: null,
      nextAttemptAt: null,
    },
  });
  if (updated.count !== 1) {
    // A result may only settle the exact attempt that sent it. In particular,
    // an expired lease can become uncertain while this request is still live.
    const settled = await db.commerceCheckout.findUnique({
      where: { id: claim.checkoutId },
      select: { attempts: true, status: true, hostedCheckoutUrl: true, hostedCheckoutRef: true, nextAttemptAt: true },
    });
    if (settled?.attempts === claim.attempts && settled.hostedCheckoutUrl && settled.status === "READY") {
      return { kind: "ready", checkoutUrl: settled.hostedCheckoutUrl, checkoutRef: settled.hostedCheckoutRef };
    }
    return { kind: "uncertain" };
  }
  return { kind: "ready", checkoutUrl, checkoutRef: hosted.checkoutRef };
}
