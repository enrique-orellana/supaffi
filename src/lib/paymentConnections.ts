import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { instanceDomain } from "@/lib/instance";
import { SqlSchema } from "@/lib/sqlSchema";

type NowPaymentsCredentials = {
  webhookSecret?: string;
};

function requiredCredential(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

/** The public callback URL for a connection's opaque, stable route ID. */
export function nowPaymentsCallbackUrl(webhookRouteId: string): string | null {
  const configuredBaseUrl = process.env.SUPAFFI_WEBHOOK_BASE_URL?.trim();
  if (configuredBaseUrl) {
    if (!URL.canParse(configuredBaseUrl)) return null;
    const url = new URL(configuredBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return `${url.origin}/api/webhooks/nowpayments/${encodeURIComponent(webhookRouteId)}`;
  }

  const domain = instanceDomain();
  if (!domain) return null;
  return `https://${domain}/api/webhooks/nowpayments/${encodeURIComponent(webhookRouteId)}`;
}

/** Save the NOWPayments signed-notification secret for an owner. */
export async function connectNowPayments(
  ownerId: string,
  merchantId: string,
  input: NowPaymentsCredentials,
): Promise<void> {
  const webhookSecret = input.webhookSecret?.trim();

  await db.$transaction(async (tx) => {
    const merchants = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT ${SqlSchema.tables.Merchant.id}
      FROM ${SqlSchema.tables.Merchant.name}
      WHERE ${SqlSchema.tables.Merchant.id} = ${merchantId}
        AND ${SqlSchema.tables.Merchant.ownerId} = ${ownerId}
      FOR UPDATE
    `);
    if (!merchants[0]) throw new Error("Merchant not found");

    const existing = await tx.paymentConnection.findUnique({
      where: {
        merchantId_provider: {
          merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
        },
      },
      select: {
        webhookSecretEnc: true,
      },
    });
    const webhookSecretEnc = webhookSecret
      ? encrypt(requiredCredential(webhookSecret, "IPN secret"))
      : (existing?.webhookSecretEnc ?? null);
    if (!webhookSecretEnc)
      throw new Error("NOWPayments IPN secret is required");

    await tx.paymentConnection.upsert({
      where: {
        merchantId_provider: {
          merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
        },
      },
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
  merchantId: string,
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
  merchantId: string,
): Promise<{
  connected: boolean;
  hasIpnSecret: boolean;
  hasCallbackId: boolean;
  callbackUrl: string | null;
  feeFallbackPercent?: string | null;
}> {
  const connection = await db.paymentConnection.findFirst({
    where: {
      merchantId,
      provider: PaymentProvider.NOWPAYMENTS.database,
      merchant: { ownerId },
    },
    select: {
      webhookSecretEnc: true,
      status: true,
      enabled: true,
      webhookRouteId: true,
      feeFallbackPercent: true,
    },
  });
  const connected = Boolean(
    connection?.status === "CONNECTED" &&
    connection.enabled &&
    connection.webhookSecretEnc,
  );
  return {
    connected,
    hasIpnSecret: Boolean(connection?.webhookSecretEnc),
    hasCallbackId: Boolean(connection?.webhookRouteId),
    callbackUrl: connection
      ? nowPaymentsCallbackUrl(connection.webhookRouteId)
      : null,
    feeFallbackPercent: connection?.feeFallbackPercent?.toString() ?? null,
  };
}
