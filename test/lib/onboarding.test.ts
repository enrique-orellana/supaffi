import { describe, it, expect } from "vitest";
import { PaymentProvider } from "@/lib/payments/types";
import {
  stepIds,
  stepIndex,
  displayStep,
  stepStates,
  nextStep,
  previousStep,
  resumeStep,
  stepPath,
  suggestSubdomain,
  backToDashboardHref,
  checkSectionFor,
  siteHost,
  splitSubdomain,
  rehomeSubdomain,
  dnsRecordName,
  dnsZone,
  normalizeStepId,
  isStepId,
  stepLabel,
} from "@/lib/onboarding";
import type { ProductSetup } from "@/lib/productSetup";
import type { ProductChecks } from "@/lib/checks/product";

const ok = { ok: true, detail: "" };
const no = { ok: false, detail: "" };

const setup = (over: Partial<ProductSetup> = {}): ProductSetup => ({
  stripeConnected: false,
  stripeKeyStored: false,
  stripeWebhookStored: false,
  integrationsConnected: false,
  connectedPaymentProviders: [],
  firstProgramSlug: null,
  trackingStatus: "not-started",
  affiliateCount: 0,
  doneCount: 0,
  totalSteps: 3,
  complete: false,
  ...over,
});

const checks = (over: Partial<ProductChecks> = {}): ProductChecks => ({
  dns: { resolves: no, https: no, certificate: no },
  stripe: { key: no, webhook: no },
  tracking: { script: no },
  ...over,
});

describe("stepIds", () => {
  it("has five steps, the finished screen not being one", () => {
    expect(stepIds()).toEqual([
      "product",
      "subdomain",
      "payments",
      "terms",
      "tracking",
    ]);
    expect(stepIds()).not.toContain("link");
  });
  it("has no webhook step: the key's own save creates the endpoint", () => {
    expect(stepIds()).not.toContain("stripe-webhook");
  });
});

describe("stepStates", () => {
  it("marks the product done and the current step current", () => {
    const states = stepStates({
      setup: setup(),
      checks: checks(),
      onboardingCompletedAt: null,
      current: "subdomain",
    });
    expect(states.find((s) => s.id === "product")?.state).toBe("done");
    expect(states.find((s) => s.id === "subdomain")?.state).toBe("current");
    expect(states.find((s) => s.id === "terms")?.state).toBe("upcoming");
  });

  it("shows a stored step as done once it is behind the user", () => {
    const states = stepStates({
      setup: setup({
        stripeConnected: true,
        stripeKeyStored: true,
        stripeWebhookStored: true,
        integrationsConnected: true,
        connectedPaymentProviders: [PaymentProvider.STRIPE.id],
      }),
      checks: checks({ stripe: { key: ok, webhook: no } }),
      onboardingCompletedAt: null,
      current: "terms",
    });
    expect(states.find((s) => s.id === "payments")?.state).toBe("done");
  });

  it("keeps Payments waiting when the stored Stripe key fails its check", () => {
    const states = stepStates({
      setup: setup({
        stripeConnected: true,
        stripeKeyStored: true,
        stripeWebhookStored: true,
        integrationsConnected: true,
        connectedPaymentProviders: [PaymentProvider.STRIPE.id],
      }),
      checks: checks({ stripe: { key: no, webhook: ok } }),
      onboardingCompletedAt: null,
      current: "terms",
    });

    expect(states.find((s) => s.id === "payments")?.state).toBe("waiting");
  });

  it.each([
    {
      description: "no providers",
      connectedPaymentProviders: [],
      stripeKeyOk: false,
      expected: "waiting",
    },
    {
      description: "NOWPayments alone",
      connectedPaymentProviders: [PaymentProvider.NOWPAYMENTS.id],
      stripeKeyOk: false,
      expected: "done",
    },
    {
      description: "Stripe alone after its key passes",
      connectedPaymentProviders: [PaymentProvider.STRIPE.id],
      stripeKeyOk: true,
      expected: "done",
    },
    {
      description: "both providers",
      connectedPaymentProviders: [
        PaymentProvider.STRIPE.id,
        PaymentProvider.NOWPAYMENTS.id,
      ],
      stripeKeyOk: true,
      expected: "done",
    },
  ] satisfies {
    description: string;
    connectedPaymentProviders: ProductSetup["connectedPaymentProviders"];
    stripeKeyOk: boolean;
    expected: "waiting" | "done";
  }[])(
    "marks Payments correctly for $description",
    ({ connectedPaymentProviders, stripeKeyOk, expected }) => {
      const states = stepStates({
        setup: setup({ connectedPaymentProviders }),
        checks: checks({ stripe: { key: stripeKeyOk ? ok : no, webhook: no } }),
        onboardingCompletedAt: null,
        current: "terms",
      });
      expect(states.find((s) => s.id === "payments")?.state).toBe(expected);
    },
  );

  it("a step the user walked past is waiting while its check says no", () => {
    // Pressing Continue is not evidence. A record that was deleted, or a
    // certificate that never issued, has to keep showing amber wherever the
    // Owner is standing, or the rail says the setup is finished when it is
    // not.
    const partial = stepStates({
      setup: setup(),
      checks: checks({ dns: { resolves: ok, https: ok, certificate: no } }),
      onboardingCompletedAt: null,
      current: "terms",
    });
    expect(partial.find((s) => s.id === "subdomain")?.state).toBe("waiting");
    const full = stepStates({
      setup: setup(),
      checks: checks({ dns: { resolves: ok, https: ok, certificate: ok } }),
      onboardingCompletedAt: null,
      current: "terms",
    });
    expect(full.find((s) => s.id === "subdomain")?.state).toBe("done");
  });

  it("stays current while a provider is connected", () => {
    const states = stepStates({
      setup: setup({
        stripeConnected: true,
        stripeKeyStored: true,
        stripeWebhookStored: true,
        connectedPaymentProviders: [PaymentProvider.STRIPE.id],
      }),
      checks: checks({ stripe: { key: ok, webhook: no } }),
      onboardingCompletedAt: null,
      current: "payments",
    });
    expect(states.find((s) => s.id === "payments")?.state).toBe("current");
  });

  it("keeps finished steps finished when the user navigates back to an earlier one", () => {
    // The trap: standing on subdomain used to demote every completed step
    // after it to "upcoming", which the rail renders grey and unclickable.
    const states = stepStates({
      setup: setup({
        stripeConnected: true,
        stripeKeyStored: true,
        stripeWebhookStored: true,
        connectedPaymentProviders: [PaymentProvider.STRIPE.id],
        firstProgramSlug: "standard",
        trackingStatus: "verified",
      }),
      checks: checks({
        stripe: { key: ok, webhook: ok },
        tracking: { script: ok },
      }),
      onboardingCompletedAt: null,
      current: "subdomain",
    });
    for (const id of ["payments", "terms", "tracking"]) {
      expect(states.find((s) => s.id === id)?.state, id).toBe("done");
    }
  });

  it("a step nobody has reached is still upcoming", () => {
    const states = stepStates({
      setup: setup(),
      checks: checks(),
      onboardingCompletedAt: null,
      current: "subdomain",
    });
    expect(states.find((s) => s.id === "payments")?.state).toBe("upcoming");
    expect(states.find((s) => s.id === "tracking")?.state).toBe("upcoming");
  });

  it("does not hold the subdomain open where nothing outside can reach the instance", () => {
    const states = stepStates({
      setup: setup(),
      checks: checks(),
      onboardingCompletedAt: null,
      current: "terms",
      dnsUnavailable: true,
    });
    expect(states.find((s) => s.id === "subdomain")?.state).toBe("done");
  });

  it("product stays current while the user is on it", () => {
    const states = stepStates({
      setup: setup(),
      checks: checks(),
      onboardingCompletedAt: null,
      current: "product",
    });
    expect(states.find((s) => s.id === "product")?.state).toBe("current");
  });
});

describe("displayStep", () => {
  it("counts the steps there are, with nothing added for work already done", () => {
    expect(displayStep("product")).toEqual({ index: 1, total: 5 });
    expect(displayStep("payments")).toEqual({ index: 3, total: 5 });
    expect(displayStep("terms")).toEqual({ index: 4, total: 5 });
  });
});

describe("stepIndex", () => {
  it("counts from one", () => {
    expect(stepIndex("product")).toBe(1);
    expect(stepIndex("payments")).toBe(3);
    expect(stepIndex("terms")).toBe(4);
  });
});

describe("navigation", () => {
  it("walks forward and back", () => {
    expect(nextStep("payments")).toBe("terms");
    expect(previousStep("terms")).toBe("payments");
    expect(nextStep("tracking")).toBeNull();
    expect(previousStep("product")).toBeNull();
  });

  it("builds the path", () => {
    expect(stepPath("instantgradient", "payments")).toBe(
      "/onboarding/instantgradient/payments",
    );
  });

  it("normalizes the legacy Stripe step and rejects unknown step ids", () => {
    expect(normalizeStepId("stripe-key")).toBe("payments");
    expect(isStepId(normalizeStepId("stripe-key"))).toBe(true);
    expect(isStepId(normalizeStepId("not-a-step"))).toBe(false);
    expect(stepLabel("payments")).toBe("Payments");
  });
});

describe("resumeStep", () => {
  it("lands on the first step whose stored data is missing", () => {
    // Nothing stored anywhere means the Owner never got past the subdomain.
    expect(resumeStep(setup(), null)).toBe("subdomain");
    expect(
      resumeStep(
        setup({
          stripeConnected: true,
          stripeKeyStored: true,
          stripeWebhookStored: true,
          connectedPaymentProviders: [PaymentProvider.STRIPE.id],
        }),
        null,
      ),
    ).toBe("terms");
    expect(
      resumeStep(
        setup({
          stripeConnected: true,
          stripeKeyStored: true,
          stripeWebhookStored: true,
          connectedPaymentProviders: [PaymentProvider.STRIPE.id],
          firstProgramSlug: "standard",
        }),
        null,
      ),
    ).toBe("tracking");
  });
  it("moves past Payments once a provider is connected", () => {
    expect(
      resumeStep(
        setup({
          stripeKeyStored: true,
          stripeWebhookStored: false,
          connectedPaymentProviders: [PaymentProvider.STRIPE.id],
        }),
        null,
      ),
    ).toBe("terms");
  });

  it("resumes at Payments until any provider is connected", () => {
    expect(
      resumeStep(
        setup({ firstProgramSlug: "standard", trackingStatus: "verified" }),
        null,
      ),
    ).toBe("payments");
    expect(
      resumeStep(
        setup({
          connectedPaymentProviders: [PaymentProvider.NOWPAYMENTS.id],
          firstProgramSlug: "standard",
          trackingStatus: "verified",
        }),
        null,
      ),
    ).toBeNull();
  });
  it("returns no resume step when every setup step is complete", () => {
    expect(
      resumeStep(
        setup({
          stripeConnected: true,
          stripeKeyStored: true,
          stripeWebhookStored: true,
          connectedPaymentProviders: [PaymentProvider.STRIPE.id],
          firstProgramSlug: "standard",
          trackingStatus: "awaiting-sale",
        }),
        null,
      ),
    ).toBeNull();
  });
});

describe("suggestSubdomain", () => {
  it("prefixes go to the site's host", () => {
    expect(suggestSubdomain("https://instantgradient.com")).toBe(
      "affiliates.instantgradient.com",
    );
    expect(suggestSubdomain("https://www.mokkit.co/pricing")).toBe(
      "affiliates.mokkit.co",
    );
  });
  it("gives nothing for an address it cannot read", () => {
    expect(suggestSubdomain("not a url")).toBe("");
  });
});

describe("backToDashboardHref", () => {
  it("offers the dashboard only when another product has finished onboarding", () => {
    expect(backToDashboardHref([])).toBeNull();
    expect(backToDashboardHref([{ onboardingCompletedAt: null }])).toBeNull();
    expect(
      backToDashboardHref([
        { onboardingCompletedAt: null },
        { onboardingCompletedAt: new Date() },
      ]),
    ).toBe("/dashboard");
  });
});

describe("checkSectionFor", () => {
  it("names the one group of checks the step's screen shows", () => {
    expect(checkSectionFor("subdomain")).toBe("dns");
    expect(checkSectionFor("payments")).toBeNull();
    expect(checkSectionFor("tracking")).toBe("tracking");
    expect(checkSectionFor("product")).toBeNull();
    expect(checkSectionFor("terms")).toBeNull();
  });
});

describe("siteHost", () => {
  it("is the hostname, or the raw address when it cannot be read", () => {
    expect(siteHost("https://www.instantgradient.com/pricing")).toBe(
      "www.instantgradient.com",
    );
    expect(siteHost("instantgradient.com")).toBe("instantgradient.com");
  });
});

describe("splitSubdomain", () => {
  it("splits the label a user may change from the root they may not", () => {
    expect(
      splitSubdomain(
        "affiliates.instantgradient.com",
        "https://instantgradient.com",
      ),
    ).toEqual({
      prefix: "affiliates",
      suffix: ".instantgradient.com",
    });
  });

  it("ignores www on the website when matching the root", () => {
    expect(
      splitSubdomain("affiliates.mokkit.co", "https://www.mokkit.co"),
    ).toEqual({
      prefix: "affiliates",
      suffix: ".mokkit.co",
    });
  });

  it("refuses to split an address that is not under the product's own site", () => {
    expect(
      splitSubdomain(
        "affiliates.somewhereelse.com",
        "https://instantgradient.com",
      ),
    ).toBeNull();
    expect(
      splitSubdomain("localhost:3600", "http://localhost:3600"),
    ).toBeNull();
  });
});

describe("dnsZone", () => {
  it("is the registrable domain, three labels under a country code suffix", () => {
    expect(dnsZone("affiliates.dev.mokkit.co")).toBe("mokkit.co");
    expect(dnsZone("affiliates.example.co.uk")).toBe("example.co.uk");
  });
});

describe("dnsRecordName", () => {
  it("keeps the middle labels when the site is on a subdomain", () => {
    // The zone is mokkit.co, so Cloudflare wants affiliates.dev, and the
    // prefix alone would create affiliates.mokkit.co instead.
    expect(dnsRecordName("affiliates.dev.mokkit.co")).toBe("affiliates.dev");
  });

  it("is just the prefix on a bare domain", () => {
    expect(dnsRecordName("affiliates.mokkit.co")).toBe("affiliates");
  });

  it("handles a public suffix without a suffix list", () => {
    expect(dnsRecordName("affiliates.example.co.uk")).toBe("affiliates");
  });

  it("returns the whole name when there is no zone to strip", () => {
    expect(dnsRecordName("mokkit.co")).toBe("mokkit.co");
  });
});

describe("rehomeSubdomain", () => {
  it("carries a chosen label onto the new site when the website is corrected", () => {
    expect(
      rehomeSubdomain(
        "affiliates.instantgradient.com",
        "https://instantgradient.com",
        "https://mokkit.co",
      ),
    ).toBe("affiliates.mokkit.co");
  });

  it("falls back to the default label when there was none to carry", () => {
    expect(
      rehomeSubdomain(
        "localhost:3600",
        "http://localhost:3600",
        "https://mokkit.co",
      ),
    ).toBe("affiliates.mokkit.co");
  });

  it("leaves the address alone when the new website yields nothing usable", () => {
    expect(
      rehomeSubdomain("affiliates.mokkit.co", "https://mokkit.co", "not a url"),
    ).toBe("affiliates.mokkit.co");
  });
});
