import { createHash, createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CommerceEventDelivery } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 20;
const CLAIM_LEASE_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 4 * 60 * 60_000;

/** Add a normalized event to the outbox inside its payment transaction. */
export async function enqueueCommerceEvent(
  tx: Prisma.TransactionClient,
  input: {
    merchantId: string;
    /** Stable provider/event identity within this Merchant across retries. */
    eventId: string;
    payload: Prisma.InputJsonObject;
  }
): Promise<void> {
  if (!/^[a-z\d:_-]{1,200}$/i.test(input.eventId)) {
    throw new Error("Invalid commerce event ID");
  }

  const integration = await tx.commerceIntegration.findUnique({
    where: { merchantId: input.merchantId },
    select: { id: true, eventDestination: true },
  });
  if (!integration?.eventDestination) return;

  // The database eventId is globally unique, so namespace the caller's stable
  // provider/event identity with its Merchant before persisting it.
  const eventId = `evt_${createHash("sha256")
    .update(input.merchantId, "utf8")
    .update("\0", "utf8")
    .update(input.eventId, "utf8")
    .digest("hex")}`;

  await tx.commerceEventDelivery.createMany({
    data: [{
      merchantId: input.merchantId,
      integrationId: integration.id,
      eventId,
      payload: input.payload,
    }],
    skipDuplicates: true,
  });
}

/** Claim a bounded batch, recovering PROCESSING rows after their lease expires. */
async function claimCommerceDeliveryBatch(): Promise<CommerceEventDelivery[]> {
  await db.$executeRaw`
    UPDATE "CommerceEventDelivery"
    SET status = 'FAILED',
        "lastError" = COALESCE("lastError", 'The worker stopped while delivering this event.')
    WHERE status = 'PROCESSING'
      AND "nextAttemptAt" <= now()
      AND attempts >= ${MAX_ATTEMPTS};
  `;

  return db.$queryRaw<CommerceEventDelivery[]>(Prisma.sql`
    WITH claimed AS (
      SELECT id
      FROM "CommerceEventDelivery"
      WHERE status IN ('PENDING', 'PROCESSING')
        AND "nextAttemptAt" <= now()
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    )
    UPDATE "CommerceEventDelivery" delivery
    SET status = 'PROCESSING',
        attempts = delivery.attempts + 1,
        "nextAttemptAt" = now() + ${CLAIM_LEASE_SECONDS} * interval '1 second'
    FROM claimed
    WHERE delivery.id = claimed.id
    RETURNING delivery.*;
  `);
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, normalize(record[key])])
      );
    }
    return current;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error("Commerce event payload is not serializable");
  return serialized;
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function markCommerceDeliveryDelivered(id: string, attempts: number): Promise<void> {
  await db.commerceEventDelivery.updateMany({
    where: { id, status: "PROCESSING", attempts },
    data: {
      status: "DELIVERED",
      deliveredAt: new Date(),
      lastError: null,
    },
  });
}

async function markCommerceDeliveryFailed(
  id: string,
  attempts: number,
  error: unknown
): Promise<void> {
  const terminal = attempts >= MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : "Commerce event delivery failed";
  await db.commerceEventDelivery.updateMany({
    where: { id, status: "PROCESSING", attempts },
    data: {
      status: terminal ? "FAILED" : "PENDING",
      lastError: message.slice(0, 1000),
      nextAttemptAt: terminal ? new Date() : new Date(Date.now() + backoffMs(attempts)),
    },
  });
}

async function deliverCommerceEvent(delivery: CommerceEventDelivery): Promise<void> {
  const integration = await db.commerceIntegration.findFirst({
    where: { id: delivery.integrationId, merchantId: delivery.merchantId },
    select: { secretEnc: true, eventDestination: true },
  });
  if (!integration?.eventDestination) throw new Error("Commerce event destination is not configured");

  const destination = await publicHttpsUrl(integration.eventDestination);
  if (!destination) throw new Error("Commerce event destination failed the public HTTPS check");

  let secret: string;
  try {
    secret = decrypt(integration.secretEnc);
  } catch {
    throw new Error("Commerce event signing secret cannot be read");
  }

  // The event ID is inside the signed bytes and also sent as a header so the
  // receiver can deduplicate deliveries even when a retry gets a new timestamp.
  const body = stableJson({ id: delivery.eventId, data: delivery.payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");

  let response: Response;
  try {
    response = await fetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-commerce-event-id": delivery.eventId,
        "x-commerce-timestamp": timestamp,
        "x-commerce-signature": signature,
      },
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Commerce event request failed or timed out");
  }
  try {
    await response.body?.cancel();
  } catch {
    // The status is still enough to determine delivery success; do not retain
    // a potentially large response body if the peer closes the stream badly.
  }
  if (!response.ok) throw new Error(`Commerce endpoint returned HTTP ${response.status}`);
}

/** Deliver one bounded batch; a crash leaves rows to be reclaimed after the lease. */
export async function processCommerceDeliveryBatch(): Promise<void> {
  const batch = await claimCommerceDeliveryBatch();
  for (const delivery of batch) {
    try {
      await deliverCommerceEvent(delivery);
      await markCommerceDeliveryDelivered(delivery.id, delivery.attempts);
    } catch (error) {
      await markCommerceDeliveryFailed(delivery.id, delivery.attempts, error);
      console.error(`[worker] commerce event ${delivery.eventId} delivery failed`,
        error instanceof Error ? error.message : "unknown error");
    }
  }
}
