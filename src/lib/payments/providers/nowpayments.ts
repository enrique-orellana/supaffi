import { PaymentProvider } from "../types";
import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentProviderAdapter, VerifiedProviderEvent } from "../types";

export const NOWPAYMENTS_PAYMENT_STATUS = {
  WAITING: "waiting",
  CONFIRMING: "confirming",
  CONFIRMED: "confirmed",
  SENDING: "sending",
  PARTIALLY_PAID: "partially_paid",
  FINISHED: "finished",
  FAILED: "failed",
  REFUNDED: "refunded",
  EXPIRED: "expired",
} as const;

const STATUS_KIND: Readonly<Record<string, VerifiedProviderEvent["kind"]>> = {
  [NOWPAYMENTS_PAYMENT_STATUS.WAITING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.CONFIRMED]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.SENDING]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.PARTIALLY_PAID]: "payment_pending",
  [NOWPAYMENTS_PAYMENT_STATUS.FINISHED]: "payment_succeeded",
  [NOWPAYMENTS_PAYMENT_STATUS.FAILED]: "payment_failed",
  [NOWPAYMENTS_PAYMENT_STATUS.EXPIRED]: "payment_failed",
  [NOWPAYMENTS_PAYMENT_STATUS.REFUNDED]: "payment_refunded",
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
  const normalizedFraction = expandedFraction?.replace(/0+$/, "");
  const normalized = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
  if (/^0(?:\.0*)?$/.test(normalized)) return "0";
  return negative ? `-${normalized}` : normalized;
}

function numericTokensMatchCanonicalValue(
  parsed: unknown,
  lossless: unknown,
): boolean {
  if (typeof parsed === "number") {
    if (!Number.isFinite(parsed) || typeof lossless !== "string") return false;
    const rawValue = decimalText(lossless);
    const canonicalValue = decimalText(String(parsed));
    return rawValue !== null && rawValue === canonicalValue;
  }
  if (Array.isArray(parsed)) {
    return (
      Array.isArray(lossless) &&
      parsed.length === lossless.length &&
      parsed.every((value, index) =>
        numericTokensMatchCanonicalValue(value, lossless[index]),
      )
    );
  }
  if (parsed && typeof parsed === "object") {
    if (!lossless || typeof lossless !== "object" || Array.isArray(lossless))
      return false;
    const entries = Object.entries(parsed);
    const losslessObject = lossless as Record<string, unknown>;
    return (
      entries.length === Object.keys(losslessObject).length &&
      entries.every(([key, value]) =>
        numericTokensMatchCanonicalValue(value, losslessObject[key]),
      )
    );
  }
  return true;
}

function canonicalizeLosslessNumbers(
  parsed: unknown,
  lossless: unknown,
): unknown {
  if (typeof parsed === "number") {
    if (
      typeof lossless === "string" &&
      numericTokensMatchCanonicalValue(parsed, lossless)
    )
      return lossless;
    return Number.isFinite(parsed) ? String(parsed) : null;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((value, index) =>
      canonicalizeLosslessNumbers(
        value,
        Array.isArray(lossless) ? lossless[index] : undefined,
      ),
    );
  }
  if (parsed && typeof parsed === "object") {
    const losslessObject =
      lossless && typeof lossless === "object" && !Array.isArray(lossless)
        ? (lossless as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        canonicalizeLosslessNumbers(value, losslessObject[key]),
      ]),
    );
  }
  return lossless;
}

type DecimalPrecision = {
  integerDigits: number;
  fractionDigits: number;
};

function exactDecimalField(
  rawValues: Map<string, string>,
  payload: JsonObject,
  key: string,
  precision?: DecimalPrecision,
  requirePositive = false,
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
  if (!result || result.startsWith("-")) return null;
  if (precision) {
    const [integer, fraction = ""] = result.split(".");
    if (
      integer.length > precision.integerDigits ||
      fraction.length > precision.fractionDigits
    )
      return null;
  }
  if (requirePositive && result === "0") return null;
  return result;
}

function stringId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
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
    // Sale amount determines commission, so reject if its exact raw decimal
    // differs from the number authenticated by the HMAC. Optional crypto
    // amounts can exceed JavaScript's decimal precision; drop those below.
    if (
      !numericTokensMatchCanonicalValue(
        payload.price_amount,
        normalizedPayload.price_amount,
      )
    )
      return null;
    const cryptoAmountMatchesSignature = numericTokensMatchCanonicalValue(
      payload.actually_paid,
      normalizedPayload.actually_paid,
    );
    normalizedPayload = canonicalizeLosslessNumbers(
      payload,
      normalizedPayload,
    ) as JsonObject;

    const paymentStatus = payload.payment_status;
    if (
      typeof paymentStatus !== "string" ||
      !Object.prototype.hasOwnProperty.call(STATUS_KIND, paymentStatus)
    ) {
      return null;
    }
    const kind = STATUS_KIND[paymentStatus];
    const paymentId = stringId(payload.payment_id);
    const invoiceId = stringId(payload.invoice_id);
    const priceAmount = exactDecimalField(
      rawValues,
      payload,
      "price_amount",
      { integerDigits: 16, fractionDigits: 2 },
      true,
    );
    const priceCurrency = currencyCode(payload.price_currency, /^[a-z]{3}$/i);
    const cryptoCurrency = currencyCode(
      payload.pay_currency,
      /^[a-z0-9_-]{2,20}$/i,
    );
    const cryptoAmount = cryptoAmountMatchesSignature
      ? exactDecimalField(rawValues, payload, "actually_paid", {
          integerDigits: 20,
          fractionDigits: 18,
        })
      : null;

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
