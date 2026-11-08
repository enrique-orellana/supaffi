import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { instanceDomain } from "@/lib/instance";
import { SqlSchema } from "@/lib/sqlSchema";
import { testNowPaymentsPaymentListAccess } from "@/lib/payments/providers/nowpaymentsApi";

type NowPaymentsCredentials = {
  apiKey?: string;
  webhookSecret?: string;
  apiAccountEmail?: string;
  apiAccountPassword?: string;
};

/** Verify read-only API list access without returning or logging its token. */
export async function testNowPaymentsLookupAccess(
  ownerId: string,
  merchantId: string,
  input: {
    apiKey?: string;
    accountEmail?: string;
    accountPassword?: string;
  },
): Promise<void> {
  const connection = await db.paymentConnection.findFirst({
    where: {
      merchantId,
      provider: PaymentProvider.NOWPAYMENTS.database,
      merchant: { ownerId },
    },
    select: {
      apiKeyEnc: true,
      apiAccountEmailEnc: true,
      apiAccountPasswordEnc: true,
    },
  });
  const apiKey =
    input.apiKey?.trim() ||
    (connection?.apiKeyEnc ? decrypt(connection.apiKeyEnc) : "");
  if (!apiKey) throw new Error("NOWPayments API key is missing");
  const accountEmail =
    input.accountEmail?.trim() ||
    (connection?.apiAccountEmailEnc
      ? decrypt(connection.apiAccountEmailEnc)
      : "");
  const accountPassword =
    (input.accountPassword?.trim() ? input.accountPassword : null) ||
    (connection?.apiAccountPasswordEnc
      ? decrypt(connection.apiAccountPasswordEnc)
      : "");
  await testNowPaymentsPaymentListAccess({
    apiKey,
    email: requiredCredential(accountEmail, "Account email"),
    password: requiredCredential(accountPassword, "Account password"),
  });
}

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

/** Save NOWPayments API and optional IPN credentials for an owned merchant. */
export async function connectNowPayments(
  ownerId: string,
  merchantId: string,
  input: NowPaymentsCredentials,
): Promise<void> {
  const apiKey = input.apiKey?.trim();
  const webhookSecret = input.webhookSecret?.trim();
  const apiAccountEmail = input.apiAccountEmail?.trim();
  const apiAccountPassword = input.apiAccountPassword;
  const hasApiAccountEmail = Boolean(apiAccountEmail);
  const hasApiAccountPassword = Boolean(apiAccountPassword?.trim());
  if (hasApiAccountEmail !== hasApiAccountPassword) {
    throw new Error(
      "NOWPayments account email and password must be provided together",
    );
  }

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
        apiKeyEnc: true,
        webhookSecretEnc: true,
        apiAccountEmailEnc: true,
        apiAccountPasswordEnc: true,
      },
    });
    const apiKeyEnc = apiKey
      ? encrypt(requiredCredential(apiKey, "API key"))
      : existing?.apiKeyEnc;
    const webhookSecretEnc = webhookSecret
      ? encrypt(requiredCredential(webhookSecret, "IPN secret"))
      : (existing?.webhookSecretEnc ?? null);
    const apiAccountEmailEnc = hasApiAccountEmail
      ? encrypt(requiredCredential(apiAccountEmail!, "Account email"))
      : existing?.apiAccountEmailEnc;
    const apiAccountPasswordEnc = hasApiAccountPassword
      ? encrypt(apiAccountPassword!)
      : existing?.apiAccountPasswordEnc;
    if (!apiKeyEnc) throw new Error("NOWPayments API key is required");

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
        apiKeyEnc,
        webhookSecretEnc,
        apiAccountEmailEnc,
        apiAccountPasswordEnc,
        status: "CONNECTED",
        enabled: true,
      },
      update: {
        apiKeyEnc,
        webhookSecretEnc,
        apiAccountEmailEnc,
        apiAccountPasswordEnc,
        status: "CONNECTED",
        enabled: true,
      },
    });
    if (hasApiAccountEmail) {
      await tx.checkoutAttribution.updateMany({
        where: {
          merchantId,
          provider: PaymentProvider.NOWPAYMENTS.database,
          pollClosedAt: null,
          pollNextAt: null,
          click: { expiresAt: { gt: new Date() } },
        },
        data: {
          pollNextAt: new Date(),
          pollFailures: 0,
          pollLastError: null,
        },
      });
    }
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
        apiAccountEmailEnc: null,
        apiAccountPasswordEnc: null,
        status: "DISCONNECTED",
        enabled: false,
      },
    });
    await tx.checkoutAttribution.updateMany({
      where: {
        merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        pollClosedAt: null,
      },
      data: { pollNextAt: null },
    });
  });
}

/** Safe settings-page view: no credential ciphertext or plaintext is returned. */
export async function getNowPaymentsConnectionStatus(
  ownerId: string,
  merchantId: string,
): Promise<{
  connected: boolean;
  invoiceLookupReady: boolean;
  hasIpnSecret: boolean;
  hasCallbackId: boolean;
  callbackUrl: string | null;
}> {
  const connection = await db.paymentConnection.findFirst({
    where: {
      merchantId,
      provider: PaymentProvider.NOWPAYMENTS.database,
      merchant: { ownerId },
    },
    select: {
      apiKeyEnc: true,
      webhookSecretEnc: true,
      apiAccountEmailEnc: true,
      apiAccountPasswordEnc: true,
      status: true,
      enabled: true,
      webhookRouteId: true,
    },
  });
  const connected = Boolean(
    connection?.status === "CONNECTED" &&
    connection.enabled &&
    connection.apiKeyEnc,
  );
  return {
    connected,
    invoiceLookupReady: Boolean(
      connected &&
      connection?.apiAccountEmailEnc &&
      connection?.apiAccountPasswordEnc,
    ),
    hasIpnSecret: Boolean(connection?.webhookSecretEnc),
    hasCallbackId: Boolean(connection?.webhookRouteId),
    callbackUrl: connection
      ? nowPaymentsCallbackUrl(connection.webhookRouteId)
      : null,
  };
}
