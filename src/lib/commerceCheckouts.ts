import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getNowPaymentsCheckoutConnection } from "@/lib/paymentConnections";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";

const CHECKOUT_PROVIDER = "NOWPAYMENTS" as const;
const CHECKOUT_LEASE_MS = 10 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

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
  | { kind: "retry_later"; retryAt: Date }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

type ClaimResult =
  | { kind: "claimed"; checkoutId: string; attempts: number }
  | { kind: "ready"; checkoutUrl: string; checkoutRef: string | null }
  | { kind: "accepted"; retryAt: Date }
  | { kind: "retry_later"; retryAt: Date }
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
    if (checkout.status === "CREATING") return { kind: "accepted", retryAt: checkout.nextAttemptAt };
    if (checkout.status === "FAILED") return { kind: "retry_later", retryAt: checkout.nextAttemptAt };
  }
  return null;
}

async function readExisting(merchantId: string, sourceOrderId: string, digest: string): Promise<ClaimResult | null> {
  const checkout = await db.commerceCheckout.findUnique({
    where: {
      merchantId_provider_sourceOrderId: {
        merchantId,
        provider: CHECKOUT_PROVIDER,
        sourceOrderId,
      },
    },
    select: {
      idempotencyDigest: true,
      hostedCheckoutUrl: true,
      hostedCheckoutRef: true,
      status: true,
      nextAttemptAt: true,
    },
  });
  return checkout ? existingResult(checkout, digest, new Date()) : null;
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
        const claimed = await tx.commerceCheckout.update({
          where: { id: existing.id },
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
          select: { id: true, attempts: true },
        });
        return { kind: "claimed", checkoutId: claimed.id, attempts: claimed.attempts };
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

function retryDelay(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
}

async function persistFailure(checkoutId: string, attempts: number): Promise<Date> {
  const retryAt = new Date(Date.now() + retryDelay(attempts));
  const updated = await db.commerceCheckout.updateMany({
    where: { id: checkoutId, status: "CREATING", attempts },
    data: {
      status: "FAILED",
      hostedCheckoutRef: null,
      hostedCheckoutUrl: null,
      lastCreationError: "Hosted checkout creation failed",
      nextAttemptAt: retryAt,
    },
  });
  return updated.count === 1 ? retryAt : new Date(Date.now() + 5_000);
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
  } catch {
    const retryAt = await persistFailure(claim.checkoutId, claim.attempts);
    return { kind: "retry_later", retryAt };
  }

  const checkoutUrl = await publicHttpsUrl(hosted.checkoutUrl);
  if (!checkoutUrl) {
    const retryAt = await persistFailure(claim.checkoutId, claim.attempts);
    return { kind: "retry_later", retryAt };
  }

  const updated = await db.commerceCheckout.updateMany({
    where: {
      id: claim.checkoutId,
      status: "CREATING",
      attempts: claim.attempts,
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
    // A stale lease must not overwrite the result of a newer claim.
    return { kind: "accepted", retryAt: new Date(Date.now() + 5_000) };
  }
  return { kind: "ready", checkoutUrl, checkoutRef: hosted.checkoutRef };
}
