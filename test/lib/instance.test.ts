import { describe, it, expect, afterEach } from "vitest";
import { instanceDomain } from "@/lib/instance";

const original = process.env.SUPAFFI_DOMAIN;
const originalWebhookBaseUrl = process.env.SUPAFFI_WEBHOOK_BASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.SUPAFFI_DOMAIN;
  else process.env.SUPAFFI_DOMAIN = original;
  if (originalWebhookBaseUrl === undefined)
    delete process.env.SUPAFFI_WEBHOOK_BASE_URL;
  else process.env.SUPAFFI_WEBHOOK_BASE_URL = originalWebhookBaseUrl;
});

describe("instanceDomain", () => {
  it("returns an empty string when unset", () => {
    delete process.env.SUPAFFI_DOMAIN;
    expect(instanceDomain()).toBe("");
  });

  it("normalizes case and surrounding whitespace, because Host headers arrive lowercase and unpadded", () => {
    process.env.SUPAFFI_DOMAIN = "  Supaffi.Example.COM  ";
    expect(instanceDomain()).toBe("supaffi.example.com");
  });

  it("returns an empty string for a whitespace-only value", () => {
    process.env.SUPAFFI_DOMAIN = "   ";
    expect(instanceDomain()).toBe("");
  });

  it("reserves the webhook hostname when the admin domain is private", () => {
    delete process.env.SUPAFFI_DOMAIN;
    process.env.SUPAFFI_WEBHOOK_BASE_URL = "https://hooks.example.test";

    expect(instanceDomain()).toBe("hooks.example.test");
  });
});
