import { describe, it, expect, vi, beforeEach } from "vitest";

// The database and the decryption are stood in for, so this exercises only
// the loop's own rules: which products it touches, what it records, and that
// one failing product never stops the next.
const findUnique = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { paymentConnection: { findUnique, findMany } } }));
vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => `plain:${value}` }));

const { upgradeAllWebhookEvents, upgradeMerchantWebhookEvents } = await import("@/lib/worker/webhookEvents");

const OLD_EVENTS = ["checkout.session.completed", "invoice.paid", "charge.refunded", "customer.subscription.deleted"];

function connection(merchantId: string, extra: Record<string, unknown> = {}) {
  return {
    merchantId,
    apiKeyEnc: `key-${merchantId}`,
    webhookSecretEnc: `whsec-${merchantId}`,
    externalEndpointId: `we_${merchantId}`,
    merchant: { domain: `${merchantId}.example.com` },
    ...extra,
  };
}

describe("upgradeAllWebhookEvents", () => {
  beforeEach(() => {
    findUnique.mockReset();
    findMany.mockReset();
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("upgrades each product in turn with its own key and warns only about a real problem", async () => {
    const rows = { a: connection("a"), b: connection("b"), c: connection("c") };
    findMany.mockResolvedValue([{ merchantId: "a" }, { merchantId: "b" }, { merchantId: "c" }]);
    findUnique.mockImplementation(
      async ({ where }: { where: { merchantId_provider: { merchantId: keyof typeof rows } } }) =>
        rows[where.merchantId_provider.merchantId]
    );

    const keys: string[] = [];
    const makeClient = (key: string) => {
      keys.push(key);
      return {
        webhookEndpoints: {
          retrieve: async (id: string) => {
            if (key === "plain:key-b") throw Object.assign(new Error("no"), { type: "StripeConnectionError" });
            return { id, url: "", enabled_events: OLD_EVENTS };
          },
          list: async () => ({ data: [] }),
          update: async () => {
            if (key === "plain:key-c") throw Object.assign(new Error("no"), { type: "StripePermissionError" });
            return {};
          },
        },
      };
    };

    await upgradeAllWebhookEvents(makeClient);

    expect(keys).toEqual(["plain:key-a", "plain:key-b", "plain:key-c"]);
    // A network failure says nothing about the endpoint, so it is not warned about.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("merchant c"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Replace the key in settings"));
  });

  it("never throws when the product list cannot be read", async () => {
    findMany.mockRejectedValue(new Error("database down"));
    await expect(upgradeAllWebhookEvents(() => { throw new Error("should not be called"); })).resolves.toBeUndefined();
  });

  it("skips a product on a local address", async () => {
    findUnique.mockResolvedValue(connection("a", { merchant: { domain: "shop.localhost:3000" } }));
    const makeClient = vi.fn();
    await upgradeMerchantWebhookEvents("a", makeClient);
    expect(makeClient).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns when the endpoint is missing from Stripe, naming the fix", async () => {
    findUnique.mockResolvedValue(connection("a"));
    await upgradeMerchantWebhookEvents("a", () => ({
      webhookEndpoints: {
        retrieve: async () => {
          throw Object.assign(new Error("no"), { code: "resource_missing", statusCode: 404 });
        },
        list: async () => ({ data: [] }),
        update: async () => ({}),
      },
    }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("merchant a"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Add the webhook again"));
  });

  it("does not warn once the endpoint already has every event", async () => {
    findUnique.mockResolvedValue(connection("a"));
    await upgradeMerchantWebhookEvents("a", () => ({
      webhookEndpoints: {
        retrieve: async (id: string) => ({ id, url: "", enabled_events: ["*"] }),
        list: async () => ({ data: [] }),
        update: async () => ({}),
      },
    }));
    expect(console.warn).not.toHaveBeenCalled();
  });
});
