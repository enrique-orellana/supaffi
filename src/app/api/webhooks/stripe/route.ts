import { PaymentProvider } from "@/lib/payments/types";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { Prisma } from "@prisma/client";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { shouldLogSignatureFailure } from "@/lib/webhookSignatureLog";
import { getPaymentProviderAdapter } from "@/lib/payments/registry";
import type { VerifiedProviderEvent } from "@/lib/payments/types";

// One instance can host several Merchants (ADR 0006), each on their own
// domain, so the Merchant is resolved by which domain the request arrived
// on, same as regular traffic. Each Merchant has their own webhook signing
// secret, verified independently.
//
// This only verifies the signature and queues the event (ADR 0007) — it
// does not process it. Processing happens in the background worker, so
// this handler stays fast and returns 200 quickly, which is what Stripe
// expects to stop retrying.
export async function POST(req: NextRequest) {
  const host = req.headers.get("host");
  const signature = req.headers.get("stripe-signature");
  if (!host || !signature) {
    return new NextResponse(null, { status: 400 });
  }

  const connection = await db.paymentConnection.findFirst({
    where: { provider: PaymentProvider.STRIPE.database, merchant: { domain: host } },
    select: {
      merchantId: true,
      webhookSecretEnc: true,
    },
  });
  // No webhook secret means Stripe was never connected for this Merchant,
  // so there is nothing to verify the signature against. Treated the same as
  // an unknown domain: reject, never queue an unverifiable payload.
  if (!connection?.webhookSecretEnc) {
    return new NextResponse(null, { status: 404 });
  }

  const rawBody = await req.text();
  const adapter = getPaymentProviderAdapter(PaymentProvider.STRIPE.id);
  if (!adapter) return new NextResponse(null, { status: 404 });

  let event: VerifiedProviderEvent | null;
  try {
    event = adapter.verifyAndParseWebhook({
      rawBody,
      headers: req.headers,
      connection: {
        apiKey: null,
        webhookSecret: decrypt(connection.webhookSecretEnc),
      },
    });
  } catch {
    // Bad signature: reject outright, never queue an unverified payload.
    //
    // This used to fail in silence, so a rotated or mistyped signing secret
    // left nothing in the logs to say why no sale arrived. The address is
    // public, so the line does not claim the secret is wrong, and it is
    // limited to one per product every 15 minutes.
    if (shouldLogSignatureFailure(connection.merchantId)) {
      console.warn(
        `[webhook] rejected a request for merchant ${connection.merchantId}: its signature did not verify against the signing secret on file.`
      );
    }
    return new NextResponse(null, { status: 400 });
  }
  if (!event) return new NextResponse(null, { status: 400 });

  try {
    await db.webhookEvent.create({
      data: {
        merchantId: connection.merchantId,
        provider: PaymentProvider.STRIPE.database,
        providerEventId: event.eventId,
        payload: event.rawPayload as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // The provider-scoped identity makes a redelivery an idempotent success.
    if (!isUniqueConstraintError(err)) {
      throw err;
    }
  }

  return new NextResponse(null, { status: 200 });
}
