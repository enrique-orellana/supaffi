import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import type { VerifiedProviderEvent } from "@/lib/payments/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

async function readBoundedBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
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
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return new NextResponse(null, { status: 415 });

  const { connectionId } = await params;
  if (!/^[\da-z_-]{8,64}$/i.test(connectionId)) return new NextResponse(null, { status: 404 });

  const connection = await db.paymentConnection.findFirst({
    where: {
      webhookRouteId: connectionId,
      provider: "NOWPAYMENTS",
      enabled: true,
      status: "CONNECTED",
    },
    select: { id: true, merchantId: true, webhookSecretEnc: true },
  });
  if (!connection?.webhookSecretEnc) return new NextResponse(null, { status: 404 });

  const rawBody = await readBoundedBody(request);
  if (!rawBody) return new NextResponse(null, { status: 413 });

  const adapter = getPaymentProviderAdapter("nowpayments");
  if (!adapter) return new NextResponse(null, { status: 404 });

  let event: VerifiedProviderEvent | null;
  try {
    event = adapter.verifyAndParseWebhook({
      rawBody,
      headers: request.headers,
      connection: {
        apiKey: null,
        webhookSecret: decrypt(connection.webhookSecretEnc),
      },
    });
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!event || event.provider !== "nowpayments" || !event.paymentRef) {
    return new NextResponse(null, { status: 400 });
  }
  const providerPayload = event.rawPayload as Record<string, unknown>;
  if (
    typeof providerPayload.order_id !== "string" ||
    !providerPayload.order_id.trim() ||
    providerPayload.order_id.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(providerPayload.order_id)
  ) return new NextResponse(null, { status: 400 });

  try {
    await db.webhookEvent.create({
      data: {
        merchantId: connection.merchantId,
        provider: "NOWPAYMENTS",
        providerEventId: event.eventId,
        payload: queuedPayload(event),
      },
    });
  } catch (error) {
    // Provider event identity is unique per Merchant, so a redelivery is an
    // acknowledged success and never queues a second worker operation.
    if (!isUniqueConstraintError(error)) throw error;
  }

  return new NextResponse(null, { status: 200 });
}
