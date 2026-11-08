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

const PAYMENT_STATUSES = Object.values(NOWPAYMENTS_PAYMENT_STATUS);

export type NowPaymentsPaymentStatus =
  (typeof NOWPAYMENTS_PAYMENT_STATUS)[keyof typeof NOWPAYMENTS_PAYMENT_STATUS];

export type NowPaymentsPayment = {
  payment_id: string;
  payment_status: NowPaymentsPaymentStatus;
  invoice_id: string | null;
  order_id: string | null;
  price_amount: string;
  price_currency: string;
  pay_amount: string | null;
  pay_currency: string | null;
  actually_paid: string | null;
  network: string | null;
  updated_at: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function id(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  return null;
}

function decimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value);
  return /^(0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ? normalized : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function apiError(status: number): Error {
  return new Error(`NOWPayments API request failed (${status})`);
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("NOWPayments API returned invalid JSON");
  }
}

function apiOrigin(): string {
  const configured = process.env.NOWPAYMENTS_API_BASE_URL?.trim();
  if (!configured) return "https://api.nowpayments.io";

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("NOWPayments API base URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    !["api.nowpayments.io", "api-sandbox.nowpayments.io"].includes(
      url.hostname,
    ) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NOWPayments API base URL is invalid");
  }
  return url.origin;
}

/** Check that the API key can access NOWPayments' payment API. */
export async function testNowPaymentsApiKeyAccess(
  apiKey: string,
): Promise<void> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error("NOWPayments API key is missing");

  const response = await fetch(`${apiOrigin()}/v1/currencies`, {
    method: "GET",
    headers: { "x-api-key": normalizedApiKey },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw apiError(response.status);
  await jsonBody(response);
}

/** Fetch authoritative payment facts from NOWPayments using the merchant API key. */
export async function getNowPaymentsPayment(
  paymentId: string,
  apiKey: string,
): Promise<NowPaymentsPayment> {
  const normalizedPaymentId = paymentId.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedPaymentId || normalizedPaymentId.length > 128) {
    throw new Error("NOWPayments payment ID is invalid");
  }
  if (!normalizedApiKey) throw new Error("NOWPayments API key is missing");

  const response = await fetch(
    `${apiOrigin()}/v1/payment/${encodeURIComponent(normalizedPaymentId)}`,
    {
      method: "GET",
      headers: { "x-api-key": normalizedApiKey },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw apiError(response.status);

  const body = await jsonBody(response);
  if (!isObject(body)) throw new Error("NOWPayments API response is invalid");

  const returnedPaymentId = id(body.payment_id);
  if (returnedPaymentId !== normalizedPaymentId) {
    throw new Error("NOWPayments payment ID did not match");
  }
  if (
    typeof body.payment_status !== "string" ||
    !PAYMENT_STATUSES.includes(body.payment_status as NowPaymentsPaymentStatus)
  ) {
    throw new Error("NOWPayments API returned an unknown payment status");
  }

  const priceAmount = decimal(body.price_amount);
  const priceCurrency = optionalText(body.price_currency)?.toLowerCase();
  if (!priceAmount || !priceCurrency || !/^[a-z]{3}$/.test(priceCurrency)) {
    throw new Error("NOWPayments API response is missing the sale amount");
  }

  const updatedAt = optionalText(body.updated_at);
  return {
    payment_id: returnedPaymentId,
    payment_status: body.payment_status as NowPaymentsPaymentStatus,
    invoice_id: id(body.invoice_id),
    order_id: id(body.order_id),
    price_amount: priceAmount,
    price_currency: priceCurrency,
    pay_amount: decimal(body.pay_amount),
    pay_currency: optionalText(body.pay_currency)?.toLowerCase() ?? null,
    actually_paid: decimal(body.actually_paid),
    network: optionalText(body.network)?.toLowerCase() ?? null,
    updated_at:
      updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
  };
}
