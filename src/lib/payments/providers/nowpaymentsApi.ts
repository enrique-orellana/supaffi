import { createHash } from "node:crypto";

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

export type NowPaymentsAccountCredentials = {
  apiKey: string;
  email: string;
  password: string;
};

type CachedAuthToken = { token: string; expiresAt: number };

const authTokens = new Map<string, CachedAuthToken>();
const AUTH_TOKEN_CACHE_MS = 4 * 60_000;
const MAX_PAYMENT_LIST_PAGES = 20;

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

function invoicePayment(
  value: unknown,
  expectedInvoiceId: string,
): NowPaymentsPayment {
  if (!isObject(value))
    throw new Error("NOWPayments payment list contains an invalid payment");

  const paymentId = id(value.payment_id);
  const invoiceId = id(value.invoice_id) ?? expectedInvoiceId;
  const paymentStatus = value.payment_status;
  const priceAmount = decimal(value.price_amount);
  const priceCurrency = optionalText(value.price_currency)?.toLowerCase();
  if (
    !paymentId ||
    !priceAmount ||
    !priceCurrency ||
    !/^[a-z]{3}$/.test(priceCurrency)
  ) {
    throw new Error(
      "NOWPayments payment list is missing required payment facts",
    );
  }
  if (invoiceId !== expectedInvoiceId) {
    throw new Error("NOWPayments payment list included a different invoice ID");
  }
  if (
    typeof paymentStatus !== "string" ||
    !PAYMENT_STATUSES.includes(paymentStatus as NowPaymentsPaymentStatus)
  ) {
    throw new Error("NOWPayments API returned an unknown payment status");
  }

  const updatedAt = optionalText(value.updated_at);
  return {
    payment_id: paymentId,
    payment_status: paymentStatus as NowPaymentsPaymentStatus,
    invoice_id: invoiceId,
    order_id: id(value.order_id),
    price_amount: priceAmount,
    price_currency: priceCurrency,
    pay_amount: decimal(value.pay_amount),
    pay_currency: optionalText(value.pay_currency)?.toLowerCase() ?? null,
    actually_paid: decimal(value.actually_paid),
    network: optionalText(value.network)?.toLowerCase() ?? null,
    updated_at:
      updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
  };
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

function credentialsKey(email: string, password: string): string {
  return createHash("sha256")
    .update(email)
    .update("\0")
    .update(password)
    .digest("hex");
}

async function authenticateNowPayments(
  email: string,
  password: string,
  refresh = false,
): Promise<string> {
  const key = credentialsKey(email, password);
  const cached = authTokens.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch(`${apiOrigin()}/v1/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw apiError(response.status);

  const body = await jsonBody(response);
  if (!isObject(body) || typeof body.token !== "string" || !body.token.trim()) {
    throw new Error("NOWPayments authentication response is invalid");
  }

  const token = body.token.trim();
  authTokens.set(key, { token, expiresAt: Date.now() + AUTH_TOKEN_CACHE_MS });
  return token;
}

async function getPaymentListPage(
  invoiceId: string,
  credentials: NowPaymentsAccountCredentials,
  page: number,
  token: string,
): Promise<{ payments: NowPaymentsPayment[]; pagesCount: number | null }> {
  const query = new URLSearchParams({
    invoiceid: invoiceId,
    limit: "500",
    page: String(page),
  });
  const response = await fetch(`${apiOrigin()}/v1/payment/?${query}`, {
    method: "GET",
    headers: {
      "x-api-key": credentials.apiKey,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw apiError(response.status);

  const body = await jsonBody(response);
  if (!isObject(body) || !Array.isArray(body.data)) {
    throw new Error("NOWPayments payment list response is invalid");
  }
  const pagesCount =
    typeof body.pagesCount === "number" &&
    Number.isSafeInteger(body.pagesCount) &&
    body.pagesCount >= 0
      ? body.pagesCount
      : null;
  return {
    payments: body.data.map((payment) => invoicePayment(payment, invoiceId)),
    pagesCount,
  };
}

async function fetchPaymentListAccess(
  credentials: NowPaymentsAccountCredentials,
  token: string,
): Promise<Response> {
  const query = new URLSearchParams({ limit: "1", page: "0" });
  return fetch(`${apiOrigin()}/v1/payment/?${query}`, {
    method: "GET",
    headers: {
      "x-api-key": credentials.apiKey.trim(),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

/** Check that the configured account can use the read-only payment-list API. */
export async function testNowPaymentsPaymentListAccess(
  credentials: NowPaymentsAccountCredentials,
): Promise<void> {
  const apiKey = credentials.apiKey.trim();
  const email = credentials.email.trim();
  const password = credentials.password;
  if (!apiKey || !email || !password) {
    throw new Error("NOWPayments account lookup credentials are missing");
  }

  let token = await authenticateNowPayments(email, password);
  let response = await fetchPaymentListAccess(
    { apiKey, email, password },
    token,
  );
  if (response.status === 401) {
    token = await authenticateNowPayments(email, password, true);
    response = await fetchPaymentListAccess({ apiKey, email, password }, token);
  }
  if (!response.ok) throw apiError(response.status);

  const body = await jsonBody(response);
  if (!isObject(body) || !Array.isArray(body.data)) {
    throw new Error("NOWPayments payment list response is invalid");
  }
}

/**
 * Find payment attempts for one known invoice. The account JWT is cached only
 * in memory and refreshed before NOWPayments' five-minute expiry.
 */
export async function listNowPaymentsPaymentsByInvoice(
  invoiceId: string,
  credentials: NowPaymentsAccountCredentials,
): Promise<NowPaymentsPayment[]> {
  const normalizedInvoiceId = invoiceId.trim();
  const apiKey = credentials.apiKey.trim();
  const email = credentials.email.trim();
  const password = credentials.password;
  if (!normalizedInvoiceId || normalizedInvoiceId.length > 128) {
    throw new Error("NOWPayments invoice ID is invalid");
  }
  if (!apiKey) throw new Error("NOWPayments API key is missing");
  if (!email || !password) {
    throw new Error("NOWPayments account lookup credentials are missing");
  }

  let token = await authenticateNowPayments(email, password);
  let firstPage: Awaited<ReturnType<typeof getPaymentListPage>>;
  try {
    firstPage = await getPaymentListPage(
      normalizedInvoiceId,
      { apiKey, email, password },
      0,
      token,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith("(401)"))
      throw error;
    token = await authenticateNowPayments(email, password, true);
    firstPage = await getPaymentListPage(
      normalizedInvoiceId,
      { apiKey, email, password },
      0,
      token,
    );
  }

  const payments = [...firstPage.payments];
  const pagesCount = firstPage.pagesCount ?? 1;
  if (pagesCount > MAX_PAYMENT_LIST_PAGES) {
    throw new Error(
      "NOWPayments invoice has too many payment attempts to list safely",
    );
  }
  for (let page = 1; page < pagesCount; page++) {
    const result = await getPaymentListPage(
      normalizedInvoiceId,
      { apiKey, email, password },
      page,
      token,
    );
    payments.push(...result.payments);
  }
  return payments;
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
