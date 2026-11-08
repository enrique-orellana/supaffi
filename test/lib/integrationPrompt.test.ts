import { describe, it, expect } from "vitest";
import {
  trackingScriptPrompt,
  trackingScriptTag,
  checkoutPrompt,
} from "@/lib/integrationPrompt";

describe("trackingScriptTag", () => {
  it("suppresses the merchant page referrer on the script request", () => {
    expect(trackingScriptTag("https://affiliates.instantgradient.com")).toBe(
      '<script src="https://affiliates.instantgradient.com/track.js" referrerpolicy="no-referrer" async></script>',
    );
  });
});

describe("trackingScriptPrompt", () => {
  it("carries the snippet and the site it belongs on", () => {
    const scriptTag = trackingScriptTag(
      "https://affiliates.instantgradient.com",
    );
    const prompt = trackingScriptPrompt({
      websiteUrl: "https://instantgradient.com",
      scriptTag,
    });
    expect(prompt).toContain("https://instantgradient.com");
    expect(prompt).toContain(scriptTag);
    expect(prompt).toContain('referrerpolicy="no-referrer"');
    // Written at an assistant, not at a colleague.
    expect(prompt).not.toMatch(/developer/i);
  });
});

describe("checkoutPrompt", () => {
  it("carries the snippet and protects metadata already there", () => {
    const prompt = checkoutPrompt({
      checkoutSnippet: "await stripe.checkout.sessions.create({});",
    });
    expect(prompt).toContain("stripe.checkout.sessions.create");
    expect(prompt).toContain("already being set");
  });

  it("tells a Payment Links site there is nothing to change", () => {
    const prompt = checkoutPrompt({
      checkoutSnippet: "await stripe.checkout.sessions.create({});",
    });
    expect(prompt).toContain(
      "Payment Links, buy buttons or pricing tables, change nothing here",
    );
  });
});
