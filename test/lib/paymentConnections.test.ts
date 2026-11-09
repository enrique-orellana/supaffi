import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  tx,
  transaction,
  queryRaw,
  upsert,
  updateMany,
  findFirst,
  findExisting,
  encrypt,
} = vi.hoisted(() => {
  const queryRaw = vi.fn();
  const upsert = vi.fn();
  const findFirst = vi.fn();
  const findExisting = vi.fn();
  const updateMany = vi.fn();
  const tx = {
    $queryRaw: queryRaw,
    paymentConnection: { findUnique: findExisting, upsert, updateMany },
  };
  return {
    tx,
    queryRaw,
    upsert,
    updateMany,
    findFirst,
    findExisting,
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    transaction: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: transaction,
    paymentConnection: { findFirst },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt }));
vi.mock("@/lib/instance", () => ({ instanceDomain: () => "supaffi.example" }));

const {
  connectNowPayments,
  disconnectNowPayments,
  getNowPaymentsConnectionStatus,
  nowPaymentsCallbackUrl,
} = await import("@/lib/paymentConnections");

describe("NOWPayments connection credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transaction.mockImplementation(async (callback) => callback(tx));
    queryRaw.mockResolvedValue([{ id: "merchant-1" }]);
    findExisting.mockResolvedValue(null);
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

  it("encrypts and saves only the IPN secret", async () => {
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

  it("clears a stored API key when rotating the IPN secret", async () => {
    findExisting.mockResolvedValue({
      apiKeyEnc: "encrypted:existing-api-key",
      webhookSecretEnc: "encrypted:existing-ipn-secret",
    });

    await connectNowPayments("owner-1", "merchant-1", {
      webhookSecret: "replacement-ipn-secret",
    });

    expect(encrypt).toHaveBeenCalledExactlyOnceWith("replacement-ipn-secret");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          apiKeyEnc: null,
          webhookSecretEnc: "encrypted:replacement-ipn-secret",
        }),
      }),
    );
  });

  it("requires only the IPN secret for a ready connection", async () => {
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
      hasIpnSecret: true,
      hasCallbackId: true,
      callbackUrl:
        "https://supaffi.example/api/webhooks/nowpayments/stable-route-id",
      feeFallbackPercent: null,
    });

    findFirst.mockResolvedValue({
      webhookSecretEnc: null,
      status: "CONNECTED",
      enabled: true,
      webhookRouteId: "stable-route-id",
    });

    await expect(
      getNowPaymentsConnectionStatus("owner-1", "merchant-1"),
    ).resolves.toMatchObject({
      connected: false,
      hasIpnSecret: false,
    });
  });

  it("requires an IPN secret before connecting", async () => {
    await expect(
      connectNowPayments("owner-1", "merchant-1", {}),
    ).rejects.toThrow("NOWPayments IPN secret is required");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("clears both credentials when disconnected", async () => {
    await disconnectNowPayments("owner-1", "merchant-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyEnc: null,
          webhookSecretEnc: null,
          status: "DISCONNECTED",
          enabled: false,
        }),
      }),
    );
  });
});
