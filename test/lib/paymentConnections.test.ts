import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  tx,
  transaction,
  queryRaw,
  upsert,
  updateMany,
  updateAttributions,
  findFirst,
  findExisting,
  encrypt,
} = vi.hoisted(() => {
  const queryRaw = vi.fn();
  const upsert = vi.fn();
  const findFirst = vi.fn();
  const findExisting = vi.fn();
  const updateMany = vi.fn();
  const updateAttributions = vi.fn();
  const tx = {
    $queryRaw: queryRaw,
    paymentConnection: { findUnique: findExisting, upsert, updateMany },
    checkoutAttribution: { updateMany: updateAttributions },
  };
  return {
    tx,
    queryRaw,
    upsert,
    updateMany,
    updateAttributions,
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
vi.mock("@/lib/crypto", () => ({ encrypt, decrypt: (value: string) => value }));
vi.mock("@/lib/instance", () => ({ instanceDomain: () => "supaffi.example" }));

const {
  connectNowPayments,
  disconnectNowPayments,
  getNowPaymentsConnectionStatus,
  nowPaymentsCallbackUrl,
  testNowPaymentsLookupAccess,
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
    vi.unstubAllGlobals();
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

  it("encrypts and saves the API, IPN, and account lookup credentials", async () => {
    await connectNowPayments("owner-1", "merchant-1", {
      apiKey: "merchant-api-key",
      webhookSecret: "merchant-ipn-secret",
      apiAccountEmail: "read-only@example.test",
      apiAccountPassword: "view-only-password",
    });

    expect(encrypt).toHaveBeenNthCalledWith(1, "merchant-api-key");
    expect(encrypt).toHaveBeenNthCalledWith(2, "merchant-ipn-secret");
    expect(encrypt).toHaveBeenNthCalledWith(3, "read-only@example.test");
    expect(encrypt).toHaveBeenNthCalledWith(4, "view-only-password");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          apiKeyEnc: "encrypted:merchant-api-key",
          webhookSecretEnc: "encrypted:merchant-ipn-secret",
          apiAccountEmailEnc: "encrypted:read-only@example.test",
          apiAccountPasswordEnc: "encrypted:view-only-password",
        }),
        update: expect.objectContaining({
          apiKeyEnc: "encrypted:merchant-api-key",
          webhookSecretEnc: "encrypted:merchant-ipn-secret",
          apiAccountEmailEnc: "encrypted:read-only@example.test",
          apiAccountPasswordEnc: "encrypted:view-only-password",
        }),
      }),
    );
    expect(updateAttributions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantId: "merchant-1",
          pollClosedAt: null,
          pollNextAt: null,
        }),
      }),
    );
  });

  it("preserves the saved API key when only rotating the IPN secret", async () => {
    findExisting.mockResolvedValue({
      apiKeyEnc: "encrypted:existing-api-key",
      webhookSecretEnc: "encrypted:existing-ipn-secret",
      apiAccountEmailEnc: "encrypted:existing-email",
      apiAccountPasswordEnc: "encrypted:existing-password",
    });

    await connectNowPayments("owner-1", "merchant-1", {
      webhookSecret: "replacement-ipn-secret",
    });

    expect(encrypt).toHaveBeenCalledExactlyOnceWith("replacement-ipn-secret");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          apiKeyEnc: "encrypted:existing-api-key",
          webhookSecretEnc: "encrypted:replacement-ipn-secret",
          apiAccountEmailEnc: "encrypted:existing-email",
          apiAccountPasswordEnc: "encrypted:existing-password",
        }),
      }),
    );
  });

  it("considers an enabled API connection connected without requiring an IPN secret", async () => {
    findFirst.mockResolvedValue({
      apiKeyEnc: "encrypted:merchant-api-key",
      webhookSecretEnc: "encrypted:merchant-ipn-secret",
      apiAccountEmailEnc: "encrypted:read-only@example.test",
      apiAccountPasswordEnc: "encrypted:view-only-password",
      status: "CONNECTED",
      enabled: true,
      webhookRouteId: "stable-route-id",
    });

    await expect(
      getNowPaymentsConnectionStatus("owner-1", "merchant-1"),
    ).resolves.toEqual({
      connected: true,
      invoiceLookupReady: true,
      hasIpnSecret: true,
      hasCallbackId: true,
      callbackUrl:
        "https://supaffi.example/api/webhooks/nowpayments/stable-route-id",
    });

    findFirst.mockResolvedValue({
      apiKeyEnc: null,
      webhookSecretEnc: "encrypted:merchant-ipn-secret",
      apiAccountEmailEnc: null,
      apiAccountPasswordEnc: null,
      status: "CONNECTED",
      enabled: true,
      webhookRouteId: "stable-route-id",
    });

    await expect(
      getNowPaymentsConnectionStatus("owner-1", "merchant-1"),
    ).resolves.toMatchObject({
      connected: false,
      invoiceLookupReady: false,
      hasIpnSecret: true,
    });

    findFirst.mockResolvedValue({
      apiKeyEnc: "encrypted:merchant-api-key",
      webhookSecretEnc: null,
      apiAccountEmailEnc: "encrypted:read-only@example.test",
      apiAccountPasswordEnc: "encrypted:view-only-password",
      status: "CONNECTED",
      enabled: true,
      webhookRouteId: "stable-route-id",
    });

    await expect(
      getNowPaymentsConnectionStatus("owner-1", "merchant-1"),
    ).resolves.toMatchObject({
      connected: true,
      invoiceLookupReady: true,
      hasIpnSecret: false,
    });
  });

  it("connects the invoice API without requiring an IPN secret", async () => {
    await connectNowPayments("owner-1", "merchant-1", {
      apiKey: "merchant-api-key",
      apiAccountEmail: "read-only@example.test",
      apiAccountPassword: "view-only-password",
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          apiKeyEnc: "encrypted:merchant-api-key",
          webhookSecretEnc: null,
        }),
      }),
    );
  });

  it("rejects incomplete account lookup credentials", async () => {
    await expect(
      connectNowPayments("owner-1", "merchant-1", {
        apiKey: "merchant-api-key",
        webhookSecret: "merchant-ipn-secret",
        apiAccountEmail: "read-only@example.test",
      }),
    ).rejects.toThrow(
      "NOWPayments account email and password must be provided together",
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("clears encrypted lookup credentials when disconnected", async () => {
    await disconnectNowPayments("owner-1", "merchant-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiAccountEmailEnc: null,
          apiAccountPasswordEnc: null,
        }),
      }),
    );
    expect(updateAttributions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          merchantId: "merchant-1",
          provider: "NOWPAYMENTS",
          pollClosedAt: null,
        },
        data: { pollNextAt: null },
      }),
    );
  });

  it("checks invoice-list permission using the saved API key and returns no payment data", async () => {
    findFirst.mockResolvedValue({ apiKeyEnc: "saved-api-key" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "read-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagesCount: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testNowPaymentsLookupAccess("owner-1", "merchant-1", {
        accountEmail: "read-only@example.test",
        accountPassword: "view-only-password",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.nowpayments.io/v1/payment/?limit=1&page=0",
      expect.objectContaining({
        headers: {
          "x-api-key": "saved-api-key",
          Authorization: "Bearer read-token",
        },
      }),
    );
  });

  it("validates a replacement API key with the saved read-only account", async () => {
    findFirst.mockResolvedValue({
      apiKeyEnc: "old-api-key",
      apiAccountEmailEnc: "saved-read-only@example.test",
      apiAccountPasswordEnc: "saved-view-password",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "read-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagesCount: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await testNowPaymentsLookupAccess("owner-1", "merchant-1", {
      apiKey: "replacement-api-key",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.nowpayments.io/v1/auth",
      expect.objectContaining({
        body: JSON.stringify({
          email: "saved-read-only@example.test",
          password: "saved-view-password",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.nowpayments.io/v1/payment/?limit=1&page=0",
      expect.objectContaining({
        headers: {
          "x-api-key": "replacement-api-key",
          Authorization: "Bearer read-token",
        },
      }),
    );
  });
});
