import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SqlSchema } from "@/lib/sqlSchema";
import type { PaymentProviderDatabaseValue } from "@/lib/payments/types";

export async function saveProviderFeeFallbackPercent(
  ownerId: string,
  merchantId: string,
  provider: PaymentProviderDatabaseValue,
  feeFallbackPercent: Prisma.Decimal,
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

    await tx.paymentConnection.upsert({
      where: { merchantId_provider: { merchantId, provider } },
      create: {
        merchantId,
        provider,
        status: "DISCONNECTED",
        enabled: false,
        apiKeyEnc: null,
        webhookSecretEnc: null,
        feeFallbackPercent,
      },
      update: { feeFallbackPercent },
    });
  });
}

export async function getProviderFeeFallbackPercent(
  merchantId: string,
  provider: PaymentProviderDatabaseValue,
): Promise<Prisma.Decimal | null> {
  const connection = await db.paymentConnection.findUnique({
    where: { merchantId_provider: { merchantId, provider } },
    select: { feeFallbackPercent: true },
  });
  return connection?.feeFallbackPercent ?? null;
}
