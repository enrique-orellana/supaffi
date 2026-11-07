import { PaymentProvider } from "@/lib/payments/types";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import type { VerifiedProviderEvent } from "@/lib/payments/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

async function readBoundedBody(request: Request, maxBytes: number): Promise<Buffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return body;
  } catch {
    return null;
  }
}

function queuedPayload(event: VerifiedProviderEvent): Prisma.InputJsonObject {
  return {
    provider: event.provider,
    eventId: event.eventId,
    kind: event.kind,
    paymentRef: event.paymentRef,
    checkoutRef: event.checkoutRef,
    saleAmount: event.saleAmount,
    saleCurrency: event.saleCurrency,
    cryptoAmount: event.cryptoAmount,
    cryptoCurrency: event.cryptoCurrency,
    occurredAt: event.occurredAt.toISOString(),
    rawPayload: event.rawPayload as Prisma.InputJsonValue,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const receivedAt = new Date();
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return new NextResponse(null, { status: 415 });

  const { connectionId } = await params;
  if (!/^[\da-z_-]{8,64}$/i.test(connectionId)) return new NextResponse(null, { status: 404 });

  const connection = await db.paymentConnection.findFirst({
    where: {
      webhookRouteId: connectionId,
      provider: PaymentProvider.NOWPAYMENTS.database,
      enabled: true,
      status: "CONNECTED",
    },
    select: { id: true, merchantId: true, webhookSecretEnc: true },
  });
  if (!connection?.webhookSecretEnc) return new NextResponse(null, { status: 404 });

  const rawBodyBytes = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!rawBodyBytes?.byteLength) return new NextResponse(null, { status: 413 });

  let providerRawBody: string;
  try {
    providerRawBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBodyBytes);
  } catch {
    return new NextResponse(null, { status: 413 });
  }

  const adapter = getPaymentProviderAdapter(PaymentProvider.NOWPAYMENTS.id);
  if (!adapter) return new NextResponse(null, { status: 404 });

  let event: VerifiedProviderEvent | null;
  try {
    event = adapter.verifyAndParseWebhook({
      rawBody: providerRawBody,
      headers: request.headers,
      connection: {
        webhookSecret: decrypt(connection.webhookSecretEnc),
      },
    });
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!event || event.provider !== PaymentProvider.NOWPAYMENTS.id || !event.paymentRef) {
    return new NextResponse(null, { status: 400 });
  }
  try {
    await db.webhookEvent.create({
      data: {
        merchantId: connection.merchantId,
        provider: PaymentProvider.NOWPAYMENTS.database,
        providerEventId: event.eventId,
        payload: queuedPayload(event),
        createdAt: receivedAt,
      },
    });
  } catch (error) {
    // Provider event identity is unique per Merchant, so a redelivery is an
    // acknowledged success and never queues a second worker operation.
    if (!isUniqueConstraintError(error)) throw error;
  }

  return new NextResponse(null, { status: 200 });
}
