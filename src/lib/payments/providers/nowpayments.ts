import { PaymentProvider } from "../types";
import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentProviderAdapter, VerifiedProviderEvent } from "../types";

const STATUS_KIND: Readonly<Record<string, VerifiedProviderEvent["kind"]>> = {
  waiting: "payment_pending",
  confirming: "payment_pending",
  confirmed: "payment_pending",
  sending: "payment_pending",
  partially_paid: "payment_pending",
  finished: "payment_succeeded",
  failed: "payment_failed",
  expired: "payment_failed",
  refunded: "payment_refunded",
};

type JsonObject = Record<string, unknown>;

function sortForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForSignature);
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortForSignature(object[key])]),
    );
  }
  return value;
}

function canonicalPayload(value: unknown): string {
  return JSON.stringify(sortForSignature(value));
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function skipWhitespace(body: string, start: number): number {
  let index = start;
  while (index < body.length && /\s/.test(body[index])) index += 1;
  return index;
}

/** Read one JSON string token and return its decoded value and next offset. */
function readJsonString(
  body: string,
  start: number,
): { value: string; next: number } {
  if (body[start] !== '"') throw new Error("Invalid JSON string");
  let index = start + 1;
  while (index < body.length) {
    if (body[index] === "\\") {
      index += 2;
    } else if (body[index] === '"') {
      const next = index + 1;
      return { value: JSON.parse(body.slice(start, next)) as string, next };
    } else {
      index += 1;
    }
  }
  throw new Error("Invalid JSON string");
}

/** Skip a validated JSON value without converting numeric tokens to Number. */
function skipJsonValue(body: string, start: number): number {
  let index = skipWhitespace(body, start);
  const current = body[index];
  if (current === '"') return readJsonString(body, index).next;

  if (current === "{") {
    index = skipWhitespace(body, index + 1);
    if (body[index] === "}") return index + 1;
    while (index < body.length) {
      const key = readJsonString(body, index);
      index = skipWhitespace(body, key.next);
      if (body[index] !== ":") throw new Error("Invalid JSON object");
      index = skipJsonValue(body, index + 1);
      index = skipWhitespace(body, index);
      if (body[index] === "}") return index + 1;
      if (body[index] !== ",") throw new Error("Invalid JSON object");
      index = skipWhitespace(body, index + 1);
    }
    throw new Error("Invalid JSON object");
  }

  if (current === "[") {
    index = skipWhitespace(body, index + 1);
    if (body[index] === "]") return index + 1;
    while (index < body.length) {
      index = skipJsonValue(body, index);
      index = skipWhitespace(body, index);
      if (body[index] === "]") return index + 1;
      if (body[index] !== ",") throw new Error("Invalid JSON array");
      index = skipWhitespace(body, index + 1);
    }
    throw new Error("Invalid JSON array");
  }

  while (index < body.length && !/[\s,\]}]/.test(body[index])) index += 1;
  if (index === start) throw new Error("Invalid JSON value");
  return index;
}

/** Preserve top-level numeric lexemes for the money fields in an IPN body. */
function topLevelRawValues(body: string): Map<string, string> {
  const values = new Map<string, string>();
  let index = skipWhitespace(body, 0);
  if (body[index] !== "{") throw new Error("Invalid JSON object");
  index = skipWhitespace(body, index + 1);
  if (body[index] === "}") return values;

  while (index < body.length) {
    const key = readJsonString(body, index);
    index = skipWhitespace(body, key.next);
    if (body[index] !== ":") throw new Error("Invalid JSON object");
    index = skipWhitespace(body, index + 1);
    const valueStart = index;
    index = skipJsonValue(body, index);
    values.set(key.value, body.slice(valueStart, index));
    index = skipWhitespace(body, index);
    if (body[index] === "}") return values;
    if (body[index] !== ",") throw new Error("Invalid JSON object");
    index = skipWhitespace(body, index + 1);
  }
  throw new Error("Invalid JSON object");
}

/** Parse raw JSON while retaining every numeric token as decimal text. */
function parseLosslessValue(
  body: string,
  start: number,
): { value: unknown; next: number } {
  let index = skipWhitespace(body, start);
  const current = body[index];
  if (current === '"') {
    const parsed = readJsonString(body, index);
    return { value: parsed.value, next: parsed.next };
  }

  if (current === "{") {
    const entries: [string, unknown][] = [];
    index = skipWhitespace(body, index + 1);
    if (body[index] === "}") return { value: {}, next: index + 1 };
    while (index < body.length) {
      const key = readJsonString(body, index);
      index = skipWhitespace(body, key.next);
      if (body[index] !== ":") throw new Error("Invalid JSON object");
      const parsed = parseLosslessValue(body, index + 1);
      entries.push([key.value, parsed.value]);
      index = skipWhitespace(body, parsed.next);
      if (body[index] === "}")
        return { value: Object.fromEntries(entries), next: index + 1 };
      if (body[index] !== ",") throw new Error("Invalid JSON object");
      index = skipWhitespace(body, index + 1);
    }
    throw new Error("Invalid JSON object");
  }

  if (current === "[") {
    const values: unknown[] = [];
    index = skipWhitespace(body, index + 1);
    if (body[index] === "]") return { value: values, next: index + 1 };
    while (index < body.length) {
      const parsed = parseLosslessValue(body, index);
      values.push(parsed.value);
      index = skipWhitespace(body, parsed.next);
      if (body[index] === "]") return { value: values, next: index + 1 };
      if (body[index] !== ",") throw new Error("Invalid JSON array");
      index = skipWhitespace(body, index + 1);
    }
    throw new Error("Invalid JSON array");
  }

  const end = skipJsonValue(body, index);
  const token = body.slice(index, end);
  if (token === "true") return { value: true, next: end };
  if (token === "false") return { value: false, next: end };
  if (token === "null") return { value: null, next: end };
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
    return { value: token, next: end };
  }
  throw new Error("Invalid JSON value");
}

function losslessPayload(body: string): JsonObject {
  const parsed = parseLosslessValue(body, 0);
  if (
    skipWhitespace(body, parsed.next) !== body.length ||
    !isObject(parsed.value)
  ) {
    throw new Error("Invalid JSON object");
  }
  return parsed.value;
}

/** Expand a JSON decimal token without passing its value through binary float. */
function decimalText(value: string): string | null {
  if (!value || value.length > 128) return null;
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 128) return null;

  const negative = match[1] === "-";
  const whole = match[2];
  const fraction = match[3] ?? "";
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }

  if (expanded.length > 256) return null;
  const [expandedWhole, expandedFraction] = expanded.split(".");
  const normalizedWhole = expandedWhole.replace(/^0+(?=\d)/, "");
  const normalized =
    expandedFraction === undefined
      ? normalizedWhole
      : `${normalizedWhole}.${expandedFraction}`;
  if (/^0(?:\.0*)?$/.test(normalized)) return "0";
  return negative ? `-${normalized}` : normalized;
}

function exactDecimalField(
  rawValues: Map<string, string>,
  payload: JsonObject,
  key: string,
): string | null {
  const raw = rawValues.get(key);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") return null;
  const source = typeof value === "string" ? value : raw;
  // Ensure the field was a JSON number when JSON.parse produced a Number. The
  // raw token, not the rounded Number, is the value passed to decimalText.
  if (
    typeof value === "number" &&
    !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)
  )
    return null;
  if (typeof payload[key] !== typeof value) return null;
  const result = decimalText(source);
  return result && !result.startsWith("-") ? result : null;
}

function stringId(
  value: unknown,
  rawValues: Map<string, string>,
  key: string,
): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  const raw = rawValues.get(key);
  if (typeof value === "number" && raw && /^\d+$/.test(raw)) return raw;
  return null;
}

function currencyCode(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value)
    ? value.toLowerCase()
    : null;
}

function occurredAt(payload: JsonObject): Date {
  for (const key of ["updated_at", "created_at"]) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

export const nowpaymentsAdapter: PaymentProviderAdapter = {
  provider: PaymentProvider.NOWPAYMENTS.id,
  clientTracking: {
    responseUrlFields: ["checkout_url", "invoice_url"],
    allowedHosts: ["nowpayments.io", "sandbox.nowpayments.io"],
    path: "/payment/",
    referenceQueryParameter: "iid",
  },
  capabilities: {
    webhooks: true,
    hostedCheckout: false,
    recurringBilling: false,
    refunds: false,
    disputes: false,
  },
  verifyAndParseWebhook({ rawBody, headers, connection }) {
    if (!connection.webhookSecret) return null;
    const signature = headers.get("x-nowpayments-sig")?.trim() ?? "";
    if (!/^[a-f\d]{128}$/i.test(signature)) return null;

    let payload: unknown;
    let normalizedPayload: JsonObject;
    let rawValues: Map<string, string>;
    try {
      payload = JSON.parse(rawBody) as unknown;
      normalizedPayload = losslessPayload(rawBody);
      rawValues = topLevelRawValues(rawBody);
    } catch {
      return null;
    }
    if (!isObject(payload)) return null;

    const expected = createHmac("sha512", connection.webhookSecret)
      .update(canonicalPayload(payload), "utf8")
      .digest();
    const received = Buffer.from(signature, "hex");
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return null;

    const paymentStatus = payload.payment_status;
    if (
      typeof paymentStatus !== "string" ||
      !Object.prototype.hasOwnProperty.call(STATUS_KIND, paymentStatus)
    ) {
      return null;
    }
    const kind = STATUS_KIND[paymentStatus];
    const paymentId = stringId(payload.payment_id, rawValues, "payment_id");
    const invoiceId = stringId(payload.invoice_id, rawValues, "invoice_id");
    const priceAmount = exactDecimalField(rawValues, payload, "price_amount");
    const priceCurrency = currencyCode(payload.price_currency, /^[a-z]{3}$/i);
    const cryptoCurrency = currencyCode(
      payload.pay_currency,
      /^[a-z0-9_-]{2,20}$/i,
    );
    const cryptoAmount = exactDecimalField(rawValues, payload, "actually_paid");

    if (!paymentId || !priceAmount || !priceCurrency) {
      return null;
    }

    return {
      provider: PaymentProvider.NOWPAYMENTS.id,
      eventId: `${paymentId}:${paymentStatus}`,
      kind,
      paymentRef: paymentId,
      // Only the provider invoice ID identifies the hosted checkout captured
      // by the browser tracker. order_id is merchant supplied and is not an
      // attribution reference.
      checkoutRef: invoiceId,
      saleAmount: priceAmount,
      saleCurrency: priceCurrency,
      cryptoAmount,
      cryptoCurrency,
      occurredAt: occurredAt(payload),
      rawPayload: normalizedPayload,
    };
  },
};
