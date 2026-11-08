import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tx, transaction, queryRaw, upsert, findFirst, encrypt } = vi.hoisted(
  () => {
    const queryRaw = vi.fn();
    const upsert = vi.fn();
    const findFirst = vi.fn();
    const updateMany = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      paymentConnection: { upsert, updateMany },
    };
    return {
      tx,
      queryRaw,
      upsert,
      findFirst,
      encrypt: vi.fn((value: string) => `encrypted:${value}`),
      transaction: vi.fn(),
    };
  },
);

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: transaction,
    paymentConnection: { findFirst },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt, decrypt: (value: string) => value }));
vi.mock("@/lib/instance", () => ({ instanceDomain: () => "supaffi.example" }));

const {
  connectNowPayments,
  getNowPaymentsConnectionStatus,
  nowPaymentsCallbackUrl,
} = await import("@/lib/paymentConnections");

describe("NOWPayments connection credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (callback) => callback(tx));
    queryRaw.mockResolvedValue([{ id: "merchant-1" }]);
    upsert.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses a public webhook origin independently of the admin domain", () => {
    vi.stubEnv("SUPAFFI_WEBHOOK_BASE_URL", "https://hooks.example.test/");

    expect(nowPaymentsCallbackUrl("stable-route-id")).toBe(
      "https://hooks.example.test/api/webhooks/nowpayments/stable-route-id",
    );
  });

  it("rejects an insecure configured webhook origin", () => {
    vi.stubEnv("SUPAFFI_WEBHOOK_BASE_URL", "http://hooks.example.test");

    expect(nowPaymentsCallbackUrl("stable-route-id")).toBeNull();
  });

  it("saves only the IPN secret and clears any stored API key", async () => {
    await connectNowPayments("owner-1", "merchant-1", {
      webhookSecret: "merchant-ipn-secret",
    });

    expect(encrypt).toHaveBeenCalledExactlyOnceWith("merchant-ipn-secret");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          apiKeyEnc: null,
          webhookSecretEnc: "encrypted:merchant-ipn-secret",
        }),
        update: expect.objectContaining({
          apiKeyEnc: null,
          webhookSecretEnc: "encrypted:merchant-ipn-secret",
        }),
      }),
    );
  });

  it("considers an enabled connection with an IPN secret connected without an API key", async () => {
    findFirst.mockResolvedValue({
      webhookSecretEnc: "encrypted:merchant-ipn-secret",
      status: "CONNECTED",
      enabled: true,
      webhookRouteId: "stable-route-id",
    });

    await expect(
      getNowPaymentsConnectionStatus("owner-1", "merchant-1"),
    ).resolves.toEqual({
      connected: true,
      hasCallbackId: true,
      callbackUrl:
        "https://supaffi.example/api/webhooks/nowpayments/stable-route-id",
    });
  });
});
