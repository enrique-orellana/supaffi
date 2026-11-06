import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { instanceDomain } from "@/lib/instance";
import type { PaymentConnectionSecrets } from "@/lib/payments/types";
import { SqlSchema } from "@/lib/sqlSchema";

type NowPaymentsCredentials = {
  apiKey: string;
  webhookSecret: string;
};

function requiredCredential(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

/** The public callback URL for a connection's opaque, stable route ID. */
export function nowPaymentsCallbackUrl(webhookRouteId: string): string | null {
  const domain = instanceDomain();
  if (!domain) return null;
  return `https://${domain}/api/webhooks/nowpayments/${encodeURIComponent(webhookRouteId)}`;
}

/**
 * Save or rotate both NOWPayments credentials together. The lock and owner
 * predicate mirror Stripe's connection path, so a forged product ID cannot
 * write another owner's credentials.
 */
export async function connectNowPayments(
  ownerId: string,
  merchantId: string,
  input: NowPaymentsCredentials
): Promise<void> {
  const apiKeyEnc = encrypt(requiredCredential(input.apiKey, "API key"));
  const webhookSecretEnc = encrypt(requiredCredential(input.webhookSecret, "IPN secret"));

  await db.$transaction(async (tx) => {
    const merchants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.Merchant.id}
      FROM ${SqlSchema.tables.Merchant.name}
      WHERE ${SqlSchema.tables.Merchant.id} = ${merchantId}
        AND ${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      FOR UPDATE
    `);
    if (!merchants[0]) throw new Error("Merchant not found");

    await tx.paymentConnection.upsert({
      where: { merchantId_provider: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database } },
      create: {
        merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        apiKeyEnc,
        webhookSecretEnc,
        status: "CONNECTED",
        enabled: true,
      },
      update: {
        apiKeyEnc,
        webhookSecretEnc,
        status: "CONNECTED",
        enabled: true,
      },
    });
  });
}

/** Disconnect while retaining the opaque callback ID for a later reconnect. */
export async function disconnectNowPayments(
  ownerId: string,
  merchantId: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const merchants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.Merchant.id}
      FROM ${SqlSchema.tables.Merchant.name}
      WHERE ${SqlSchema.tables.Merchant.id} = ${merchantId}
        AND ${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      FOR UPDATE
    `);
    if (!merchants[0]) throw new Error("Merchant not found");

    await tx.paymentConnection.updateMany({
      where: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database },
      data: {
        apiKeyEnc: null,
        webhookSecretEnc: null,
        status: "DISCONNECTED",
        enabled: false,
      },
    });
  });
}

/** Safe settings-page view: no credential ciphertext or plaintext is returned. */
export async function getNowPaymentsConnectionStatus(
  ownerId: string,
  merchantId: string
): Promise<{ connected: boolean; hasCallbackId: boolean; callbackUrl: string | null }> {
  const connection = await db.paymentConnection.findFirst({
    where: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database, merchant: { ownerId } },
    select: {
      apiKeyEnc: true,
      webhookSecretEnc: true,
      status: true,
      enabled: true,
      webhookRouteId: true,
    },
  });
  const connected = Boolean(
    connection?.status === "CONNECTED" &&
      connection.enabled &&
      connection.apiKeyEnc &&
      connection.webhookSecretEnc
  );
  return {
    connected,
    hasCallbackId: Boolean(connection?.webhookRouteId),
    callbackUrl: connection ? nowPaymentsCallbackUrl(connection.webhookRouteId) : null,
  };
}

/** Server-side checkout credential read. Do not call from a Server Component. */
export async function getNowPaymentsCheckoutConnection(
  merchantId: string
): Promise<(PaymentConnectionSecrets & { connectionId: string; callbackUrl: string | null }) | null> {
  const connection = await db.paymentConnection.findUnique({
    where: { merchantId_provider: { merchantId, provider: PaymentProvider.NOWPAYMENTS.database } },
    select: {
      id: true,
      apiKeyEnc: true,
      webhookSecretEnc: true,
      status: true,
      enabled: true,
      webhookRouteId: true,
    },
  });
  if (
    !connection ||
    connection.status !== "CONNECTED" ||
    !connection.enabled ||
    !connection.apiKeyEnc ||
    !connection.webhookSecretEnc
  ) {
    return null;
  }
  return {
    connectionId: connection.id,
    apiKey: decrypt(connection.apiKeyEnc),
    webhookSecret: decrypt(connection.webhookSecretEnc),
    callbackUrl: nowPaymentsCallbackUrl(connection.webhookRouteId),
  };
}
