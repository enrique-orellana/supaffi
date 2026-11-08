import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const {
  findMerchant,
  findClick,
  findCheckoutAttribution,
  createCheckoutAttribution,
  reconcileAttribution,
} = vi.hoisted(() => ({
  findMerchant: vi.fn(),
  findClick: vi.fn(),
  findCheckoutAttribution: vi.fn(),
  createCheckoutAttribution: vi.fn(),
  reconcileAttribution: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    merchant: { findUnique: findMerchant },
    click: { findFirst: findClick },
    checkoutAttribution: {
      findUnique: findCheckoutAttribution,
      create: createCheckoutAttribution,
    },
  },
}));
vi.mock("@/lib/worker/handlers/nowpayments", () => ({
  reconcileNowPaymentsCheckoutAttribution: reconcileAttribution,
}));

const { POST, OPTIONS } =
  await import("@/app/api/track/checkout-attribution/route");

const MERCHANT_DOMAIN = "affiliates.example.test";
const MERCHANT_ID = "merchant-1";
const REFERRAL_TOKEN = "90c50a4d-2460-42c8-95cb-b2e3d9e9f2b5";
const CHECKOUT_REFERENCE = "np-invoice-123";
const ALLOWED_ORIGIN = "https://product.example.test";

function request(
  body: unknown,
  options: { origin?: string; host?: string; method?: string } = {},
) {
  return new Request(
    `https://${options.host ?? MERCHANT_DOMAIN}/api/track/checkout-attribution`,
    {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? ALLOWED_ORIGIN,
        host: options.host ?? MERCHANT_DOMAIN,
      },
      ...(options.method === "OPTIONS" ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe("POST /api/track/checkout-attribution", () => {
  beforeEach(() => {
    findMerchant
      .mockReset()
      .mockResolvedValue({ id: MERCHANT_ID, websiteUrl: ALLOWED_ORIGIN });
    findClick.mockReset().mockResolvedValue({ id: "click-1" });
    findCheckoutAttribution.mockReset().mockResolvedValue(null);
    createCheckoutAttribution
      .mockReset()
      .mockResolvedValue({ id: "attribution-1" });
    reconcileAttribution.mockReset().mockResolvedValue(undefined);
  });

  it("stores a provider checkout reference against the merchant's live click", async () => {
    const response = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(response.status).toBe(204);
    expect(findMerchant).toHaveBeenCalledWith({
      where: { domain: MERCHANT_DOMAIN },
      select: { id: true, websiteUrl: true },
    });
    expect(findClick).toHaveBeenCalledWith({
      where: {
        merchantId: MERCHANT_ID,
        referralToken: REFERRAL_TOKEN,
        expiresAt: { gt: expect.any(Date) },
        fraudConfirmedAt: null,
      },
      select: { id: true },
    });
    expect(createCheckoutAttribution).toHaveBeenCalledWith({
      data: expect.objectContaining({
        merchantId: MERCHANT_ID,
        provider: "NOWPAYMENTS",
        providerCheckoutRef: CHECKOUT_REFERENCE,
        clickId: "click-1",
        createdAt: expect.any(Date),
        pollNextAt: expect.any(Date),
      }),
    });
    expect(reconcileAttribution).toHaveBeenCalledWith({
      merchantId: MERCHANT_ID,
      providerCheckoutRef: CHECKOUT_REFERENCE,
      clickId: "click-1",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      ALLOWED_ORIGIN,
    );
  });

  it("does not replace an existing checkout's attribution", async () => {
    findCheckoutAttribution.mockResolvedValue({ clickId: "another-click" });

    const response = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(response.status).toBe(409);
    expect(createCheckoutAttribution).not.toHaveBeenCalled();
    expect(reconcileAttribution).not.toHaveBeenCalled();
  });

  it("keeps the first affiliate when two different affiliates race to register one invoice", async () => {
    findCheckoutAttribution
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ clickId: "winner-click" });
    createCheckoutAttribution.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const response = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(response.status).toBe(409);
    expect(findCheckoutAttribution).toHaveBeenCalledTimes(2);
    expect(reconcileAttribution).not.toHaveBeenCalled();
  });

  it("accepts an idempotent registration for the same click", async () => {
    findCheckoutAttribution.mockResolvedValue({ clickId: "click-1" });

    const response = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(response.status).toBe(204);
    expect(createCheckoutAttribution).not.toHaveBeenCalled();
    expect(reconcileAttribution).toHaveBeenCalledWith({
      merchantId: MERCHANT_ID,
      providerCheckoutRef: CHECKOUT_REFERENCE,
      clickId: "click-1",
    });
  });

  it("rejects an invalid, expired, or fraud-confirmed referral token", async () => {
    findClick.mockResolvedValue(null);

    const response = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(response.status).toBe(404);
    expect(createCheckoutAttribution).not.toHaveBeenCalled();
  });

  it("rejects requests from a different website origin", async () => {
    const response = await POST(
      request(
        {
          provider: "nowpayments",
          checkoutReference: CHECKOUT_REFERENCE,
          referralToken: REFERRAL_TOKEN,
        },
        { origin: "https://attacker.example.test" },
      ),
    );

    expect(response.status).toBe(403);
    expect(findClick).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers and malformed checkout references", async () => {
    const unsupported = await POST(
      request({
        provider: "stripe",
        checkoutReference: CHECKOUT_REFERENCE,
        referralToken: REFERRAL_TOKEN,
      }),
    );
    const malformed = await POST(
      request({
        provider: "nowpayments",
        checkoutReference: "bad\nreference",
        referralToken: REFERRAL_TOKEN,
      }),
    );

    expect(unsupported.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(createCheckoutAttribution).not.toHaveBeenCalled();
  });

  it("answers a valid browser preflight without writing an attribution", async () => {
    const response = await OPTIONS(request(undefined, { method: "OPTIONS" }));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
    expect(createCheckoutAttribution).not.toHaveBeenCalled();
  });
});
