import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { instanceDomain } from "@/lib/instance";
import { SqlSchema } from "@/lib/sqlSchema";

type NowPaymentsCredentials = {
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
 * Save or rotate the NOWPayments IPN secret. The lock and owner
 * predicate mirror Stripe's connection path, so a forged product ID cannot
 * write another owner's credentials.
 */
export async function connectNowPayments(
  ownerId: string,
  merchantId: string,
  input: NowPaymentsCredentials
): Promise<void> {
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
        apiKeyEnc: null,
        webhookSecretEnc,
        status: "CONNECTED",
        enabled: true,
      },
      update: {
        apiKeyEnc: null,
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
      webhookSecretEnc: true,
      status: true,
      enabled: true,
      webhookRouteId: true,
    },
  });
  const connected = Boolean(
    connection?.status === "CONNECTED" &&
      connection.enabled &&
      connection.webhookSecretEnc
  );
  return {
    connected,
    hasCallbackId: Boolean(connection?.webhookRouteId),
    callbackUrl: connection ? nowPaymentsCallbackUrl(connection.webhookRouteId) : null,
  };
}
