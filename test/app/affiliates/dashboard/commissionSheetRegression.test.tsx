import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/ui/sheet", async () => {
  const React = await import("react");
  type Props = { children?: ReactNode; className?: string };
  const wrapper = (tag: "div" | "section" | "h2" | "p") => {
    function MockPrimitive({ children, className }: Props) {
      return React.createElement(tag, { className }, children);
    }
    MockPrimitive.displayName = `Mock${tag}`;
    return MockPrimitive;
  };

  return {
    Sheet: wrapper("div"),
    SheetContent: wrapper("section"),
    SheetDescription: wrapper("p"),
    SheetHeader: wrapper("div"),
    SheetTitle: wrapper("h2"),
  };
});

import {
  AffiliateCommissionSheet,
  type AffiliateCommissionDetailView,
} from "@/app/affiliates/dashboard/commissions/AffiliateCommissionSheet";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";

function commission(
  overrides: Partial<AffiliateCommissionDetailView> = {},
): AffiliateCommissionDetailView {
  return {
    amount: "$9.80 USD",
    saleAmount: "$49.00 USD",
    grossAmount: null,
    status: COMMISSION_STATUS.PENDING,
    stateLabel: "Available 9 Dec",
    createdLabel: "9 Nov",
    payableLabel: "9 Dec",
    paidLabel: null,
    voidedLabel: null,
    linkCode: "enrique",
    isAdjustment: false,
    voidReason: null,
    paymentProvider: "NOWPayments",
    ...overrides,
  };
}

function render(commissionData: AffiliateCommissionDetailView): string {
  return renderToStaticMarkup(
    createElement(AffiliateCommissionSheet, {
      commission: commissionData,
      listHref: "/affiliates/dashboard/commissions",
    }),
  );
}

function countText(markup: string, text: string): number {
  return markup.split(text).length - 1;
}

describe("affiliate commission detail rows", () => {
  it("shows pending status and dates once in labeled rows", () => {
    const markup = render(commission());

    expect(markup).toMatch(/<dt[^>]*>Status<\/dt><dd[^>]*>.*?On hold/s);
    expect(markup).toContain("Commission date</dt>");
    expect(markup).toContain("Expected availability</dt>");
    expect(countText(markup, "9 Nov")).toBe(1);
    expect(countText(markup, "9 Dec")).toBe(1);
    expect(markup).toContain("<p>Commission</p>");
  });

  it("shows a past-due pending commission as checking availability", () => {
    const markup = render(
      commission({
        stateLabel: "Checking availability",
        payableLabel: "6 Nov",
      }),
    );

    expect(markup).toContain("Availability</dt>");
    expect(markup).toContain("Checking availability");
    expect(markup).not.toContain("Expected availability");
    expect(markup).not.toContain("6 Nov");
  });

  it("shows the paid date once as a detail row", () => {
    const markup = render(
      commission({
        status: COMMISSION_STATUS.PAID,
        stateLabel: "Paid 9 Nov",
        paidLabel: "9 Nov",
      }),
    );

    expect(markup).toContain("Paid on</dt>");
    expect(markup).toContain("Paid</span>");
    expect(countText(markup, "9 Nov")).toBe(2); // Commission date and paid date.
  });

  it("keeps a void date and sanitized reason in the detail", () => {
    const markup = render(
      commission({
        status: COMMISSION_STATUS.VOIDED,
        stateLabel: "Voided",
        voidedLabel: "10 Nov",
        voidReason: "Payment refunded",
      }),
    );

    expect(markup).toContain("Status</dt>");
    expect(markup).toContain("Voided on</dt>");
    expect(countText(markup, "10 Nov")).toBe(1);
    expect(markup).toContain("Payment refunded");
  });
});
