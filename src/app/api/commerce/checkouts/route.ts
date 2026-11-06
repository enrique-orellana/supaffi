import { NextResponse } from "next/server";
import { authenticateCommerceIntegration } from "@/lib/commerceIntegrationAuth";
import { createCommerceCheckout } from "@/lib/commerceCheckouts";

const MAX_BODY_BYTES = 32 * 1024;

async function readBoundedBody(request: Request): Promise<Buffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) return null;
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
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
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function retryAfterSeconds(retryAt: Date): string {
  return String(Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000)));
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return NextResponse.json({ error: "Expected a JSON request." }, { status: 415 });
  }

  const integrationId = request.headers.get("x-commerce-integration-id") ?? "";
  const timestamp = request.headers.get("x-commerce-timestamp") ?? "";
  const signature = request.headers.get("x-commerce-signature") ?? "";
  const rawBody = await readBoundedBody(request);
  if (!rawBody) return NextResponse.json({ error: "Request body is too large." }, { status: 413 });

  const integration = await authenticateCommerceIntegration({
    integrationId,
    timestamp,
    signature,
    rawBody,
  });
  if (!integration) return NextResponse.json({ error: "Invalid integration signature." }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const result = await createCommerceCheckout(integration.merchantId, payload);
  switch (result.kind) {
    case "ready":
      return NextResponse.json({ checkoutRef: result.checkoutRef, checkoutUrl: result.checkoutUrl });
    case "accepted":
      return NextResponse.json(
        { status: "pending", retryAfter: retryAfterSeconds(result.retryAt) },
        { status: 202, headers: { "Retry-After": retryAfterSeconds(result.retryAt) } }
      );
    case "uncertain":
      return NextResponse.json(
        {
          status: "uncertain",
          reconciliationRequired: true,
          message: "An invoice may already exist for this order. Repeating this request returns the same uncertain status and does not query NOWPayments. Reconcile the order in product settings before retrying.",
        },
        { status: 202 }
      );
    case "conflict":
      return NextResponse.json({ error: "This order ID already has a different checkout request." }, { status: 409 });
    case "invalid":
      return NextResponse.json({ error: "Checkout details or referral token are invalid." }, { status: 400 });
    case "unavailable":
      return NextResponse.json({ error: "Checkout creation is not available." }, { status: 503 });
  }
}
