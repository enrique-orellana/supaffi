import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { publicHttpsUrl } from "@/lib/publicHttpsUrl";
import { SqlSchema } from "@/lib/sqlSchema";

const SIGNATURE_WINDOW_SECONDS = 5 * 60;

export type CommerceIntegrationIdentity = {
  id: string;
  merchantId: string;
};

export type CommerceIntegrationStatus = {
  integrationId: string | null;
  configured: boolean;
  eventDestination: string | null;
};

/** Generate, encrypt and return a new secret once. */
export async function rotateCommerceIntegrationSecret(
  ownerId: string,
  merchantId: string
): Promise<{ integrationId: string; secret: string }> {
  const secret = `ci_${randomBytes(32).toString("base64url")}`;
  const secretEnc = encrypt(secret);

  const integrationId = await db.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.Merchant.id}
      FROM ${SqlSchema.tables.Merchant.name}
      WHERE ${SqlSchema.tables.Merchant.id} = ${merchantId}
        AND ${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      FOR UPDATE
    `);
    if (!owned[0]) throw new Error("Merchant not found");

    const integration = await tx.commerceIntegration.upsert({
      where: { merchantId },
      create: { merchantId, secretEnc },
      update: { secretEnc },
      select: { id: true },
    });
    return integration.id;
  });

  return { integrationId, secret };
}

/** Save a validated event destination without exposing integration secrets. */
export async function setCommerceEventDestination(
  ownerId: string,
  merchantId: string,
  value: string
): Promise<void> {
  const owned = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { id: true },
  });
  if (!owned) throw new Error("Merchant not found");

  const trimmed = value.trim();
  const eventDestination = trimmed ? await publicHttpsUrl(trimmed) : null;
  if (trimmed && !eventDestination) {
    throw new Error("Use an HTTPS URL on a public host.");
  }

  await db.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.Merchant.id}
      FROM ${SqlSchema.tables.Merchant.name}
      WHERE ${SqlSchema.tables.Merchant.id} = ${merchantId}
        AND ${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      FOR UPDATE
    `);
    if (!owned[0]) throw new Error("Merchant not found");

    const integration = await tx.commerceIntegration.findUnique({
      where: { merchantId },
      select: { id: true },
    });
    if (!integration) throw new Error("Create an integration secret first.");
    await tx.commerceIntegration.update({
      where: { id: integration.id },
      data: { eventDestination },
    });
  });
}

export async function getCommerceIntegrationStatus(
  ownerId: string,
  merchantId: string
): Promise<CommerceIntegrationStatus> {
  const integration = await db.commerceIntegration.findFirst({
    where: { merchantId, merchant: { ownerId } },
    select: { id: true, secretEnc: true, eventDestination: true },
  });
  return {
    integrationId: integration?.id ?? null,
    configured: Boolean(integration?.secretEnc),
    eventDestination: integration?.eventDestination ?? null,
  };
}

/**
 * Verify x-commerce-timestamp and x-commerce-signature against the exact body
 * bytes. The signed message is `${timestamp}.${rawBody}` encoded as UTF-8 for
 * the timestamp prefix followed by the untouched body bytes.
 */
export function verifyCommerceRequestSignature(input: {
  rawBody: Buffer;
  secret: string;
  timestamp: string;
  signature: string;
  nowSeconds?: number;
}): boolean {
  if (!isFreshTimestamp(input.timestamp, input.nowSeconds) || !/^[\da-f]{64}$/i.test(input.signature)) return false;

  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.`, "utf8")
    .update(input.rawBody)
    .digest();
  const received = Buffer.from(input.signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isFreshTimestamp(timestamp: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  return Number.isSafeInteger(timestampSeconds) &&
    Math.abs(nowSeconds - timestampSeconds) <= SIGNATURE_WINDOW_SECONDS;
}

/** Authenticate the integration identity without accepting a Merchant ID from the caller. */
export async function authenticateCommerceIntegration(input: {
  integrationId: string;
  timestamp: string;
  signature: string;
  rawBody: Buffer;
  nowSeconds?: number;
}): Promise<CommerceIntegrationIdentity | null> {
  if (
    !/^[\da-z_-]{8,64}$/i.test(input.integrationId) ||
    !isFreshTimestamp(input.timestamp, input.nowSeconds) ||
    !/^[\da-f]{64}$/i.test(input.signature)
  ) return null;
  const integration = await db.commerceIntegration.findUnique({
    where: { id: input.integrationId },
    select: { id: true, merchantId: true, secretEnc: true },
  });
  if (!integration) return null;

  let secret: string;
  try {
    secret = decrypt(integration.secretEnc);
  } catch {
    return null;
  }
  if (!verifyCommerceRequestSignature({ ...input, secret })) return null;
  return { id: integration.id, merchantId: integration.merchantId };
}
