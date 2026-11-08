import { NextResponse } from "next/server";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import { db } from "@/lib/db";
import { PaymentProvider } from "@/lib/payments/types";
import { reconcileNowPaymentsCheckoutAttribution } from "@/lib/worker/handlers/nowpayments";
import { clientAddress, isPrivateAddress } from "@/lib/clientAddress";
import {
  isCheckoutAttributionLimited,
  rememberCheckoutAttribution,
} from "@/lib/checkoutAttributionThrottle";

const MAX_BODY_BYTES = 4 * 1024;
const REFERRAL_TOKEN_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

type MerchantTrackingIdentity = { id: string; websiteUrl: string };

function corsHeaders(
  origin: string,
  preflight = false,
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": preflight ? "POST, OPTIONS" : "POST",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function allowlistedOrigin(
  websiteUrl: string,
  origin: string | null,
): string | null {
  if (!origin || origin === "null") return null;
  try {
    const siteOrigin = new URL(websiteUrl).origin;
    const requestOrigin = new URL(origin).origin;
    return siteOrigin === requestOrigin && origin === requestOrigin
      ? requestOrigin
      : null;
  } catch {
    return null;
  }
}

async function merchantForRequest(
  request: Request,
): Promise<MerchantTrackingIdentity | null> {
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!host) return null;
  return db.merchant.findUnique({
    where: { domain: host },
    select: { id: true, websiteUrl: true },
  });
}

function response(status: number, headers: HeadersInit = {}): NextResponse {
  return new NextResponse(null, { status, headers });
}

async function reconcileAttribution(
  input: {
    merchantId: string;
    providerCheckoutRef: string;
    clickId: string;
  },
  headers: Record<string, string>,
): Promise<NextResponse | null> {
  try {
    await reconcileNowPaymentsCheckoutAttribution(input);
    return null;
  } catch {
    // The association is already stored. Return a retryable result so the
    // tracker can retry while still failing open for the merchant checkout.
    return response(503, { ...headers, "Retry-After": "1" });
  }
}

async function readBoundedBody(request: Request): Promise<Buffer | null> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_BODY_BYTES
  )
    return null;
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
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function OPTIONS(request: Request): Promise<NextResponse> {
  const merchant = await merchantForRequest(request);
  if (!merchant) return response(404);
  const origin = allowlistedOrigin(
    merchant.websiteUrl,
    request.headers.get("origin"),
  );
  if (!origin) return response(403);
  return response(204, corsHeaders(origin, true));
}

export async function POST(request: Request): Promise<NextResponse> {
  const merchant = await merchantForRequest(request);
  if (!merchant) return response(404);
  const origin = allowlistedOrigin(
    merchant.websiteUrl,
    request.headers.get("origin"),
  );
  if (!origin) return response(403);
  const headers = corsHeaders(origin);

  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    return response(415, headers);
  }
  const rawBody = await readBoundedBody(request);
  if (!rawBody?.byteLength) return response(413, headers);

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    ) as unknown;
  } catch {
    return response(400, headers);
  }
  if (!isObject(payload)) return response(400, headers);

  const referralToken =
    typeof payload.referralToken === "string" ? payload.referralToken : "";
  const checkoutReference =
    typeof payload.checkoutReference === "string"
      ? payload.checkoutReference.trim()
      : "";
  if (
    payload.provider !== PaymentProvider.NOWPAYMENTS.id ||
    !REFERRAL_TOKEN_PATTERN.test(referralToken) ||
    !checkoutReference ||
    checkoutReference.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(checkoutReference)
  )
    return response(400, headers);

  // Timestamp only after the complete, valid body has arrived. A slow streamed
  // request must not be able to backdate an invoice registration past payment.
  const receivedAt = new Date();
  const click = await db.click.findFirst({
    where: {
      merchantId: merchant.id,
      referralToken,
      expiresAt: { gt: new Date() },
      fraudConfirmedAt: null,
    },
    select: { id: true },
  });
  if (!click) return response(404, headers);

  const address = clientAddress(request.headers);
  const publicAddress = address && !isPrivateAddress(address) ? address : null;
  if (publicAddress) {
    if (isCheckoutAttributionLimited(merchant.id, publicAddress))
      return response(429, headers);
    rememberCheckoutAttribution(merchant.id, publicAddress);
  }

  const uniqueWhere = {
    merchantId_provider_providerCheckoutRef: {
      merchantId: merchant.id,
      provider: PaymentProvider.NOWPAYMENTS.database,
      providerCheckoutRef: checkoutReference,
    },
  };
  const existing = await db.checkoutAttribution.findUnique({
    where: uniqueWhere,
    select: { clickId: true },
  });
  if (existing) {
    if (existing.clickId !== click.id) return response(409, headers);
    return (
      (await reconcileAttribution(
        {
          merchantId: merchant.id,
          providerCheckoutRef: checkoutReference,
          clickId: click.id,
        },
        headers,
      )) ?? response(204, headers)
    );
  }

  try {
    await db.checkoutAttribution.create({
      data: {
        merchantId: merchant.id,
        provider: PaymentProvider.NOWPAYMENTS.database,
        providerCheckoutRef: checkoutReference,
        clickId: click.id,
        createdAt: receivedAt,
      },
    });
  } catch (error) {
    // A repeated request can race the unique lookup. Re-read the winner and
    // make the registration idempotent without allowing attribution changes.
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await db.checkoutAttribution.findUnique({
      where: uniqueWhere,
      select: { clickId: true },
    });
    if (raced?.clickId !== click.id) return response(409, headers);
  }

  return (
    (await reconcileAttribution(
      {
        merchantId: merchant.id,
        providerCheckoutRef: checkoutReference,
        clickId: click.id,
      },
      headers,
    )) ?? response(204, headers)
  );
}
