import { describe, expect, it } from "vitest";
import {
  nextNowPaymentsPollAt,
  nextNowPaymentsPollErrorAt,
  shouldCloseNowPaymentsAttribution,
} from "@/lib/payments/providers/nowpaymentsPolling";

const now = new Date("2026-11-08T12:00:00.000Z");
const deadline = new Date("2026-11-20T12:00:00.000Z");

describe("NOWPayments polling schedule", () => {
  it("backs off when an invoice has no payment yet", () => {
    expect(
      nextNowPaymentsPollAt({ noPaymentChecks: 0, now, deadline }),
    ).toEqual(new Date("2026-11-08T12:05:00.000Z"));
    expect(
      nextNowPaymentsPollAt({ noPaymentChecks: 1, now, deadline }),
    ).toEqual(new Date("2026-11-08T12:15:00.000Z"));
    expect(
      nextNowPaymentsPollAt({ noPaymentChecks: 2, now, deadline }),
    ).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    expect(
      nextNowPaymentsPollAt({ noPaymentChecks: 3, now, deadline }),
    ).toEqual(new Date("2026-11-08T18:00:00.000Z"));
    expect(
      nextNowPaymentsPollAt({ noPaymentChecks: 4, now, deadline }),
    ).toEqual(new Date("2026-11-09T12:00:00.000Z"));
  });

  it("checks an active payment hourly while waiting and every five minutes while confirming", () => {
    expect(
      nextNowPaymentsPollAt({
        noPaymentChecks: 0,
        paymentStatus: "waiting",
        now,
        deadline,
      }),
    ).toEqual(new Date("2026-11-08T13:00:00.000Z"));
    expect(
      nextNowPaymentsPollAt({
        noPaymentChecks: 0,
        paymentStatus: "confirming",
        now,
        deadline,
      }),
    ).toEqual(new Date("2026-11-08T12:05:00.000Z"));
  });

  it("never schedules a check at or after the attribution deadline", () => {
    const nearDeadline = new Date("2026-11-20T11:58:00.000Z");
    expect(
      nextNowPaymentsPollAt({
        noPaymentChecks: 0,
        now: nearDeadline,
        deadline,
      }),
    ).toBeNull();
  });

  it.each(["finished", "failed", "expired", "refunded"])(
    "closes attribution for terminal status %s",
    (status) => {
      expect(shouldCloseNowPaymentsAttribution(status)).toBe(true);
      expect(
        nextNowPaymentsPollAt({
          noPaymentChecks: 0,
          paymentStatus: status,
          now,
          deadline,
        }),
      ).toBeNull();
    },
  );

  it("backs off API errors and caps them at one day", () => {
    expect(nextNowPaymentsPollErrorAt({ failures: 0, now, deadline })).toEqual(
      new Date("2026-11-08T12:01:00.000Z"),
    );
    expect(nextNowPaymentsPollErrorAt({ failures: 1, now, deadline })).toEqual(
      new Date("2026-11-08T12:05:00.000Z"),
    );
    expect(nextNowPaymentsPollErrorAt({ failures: 5, now, deadline })).toEqual(
      new Date("2026-11-09T12:00:00.000Z"),
    );
  });
});
