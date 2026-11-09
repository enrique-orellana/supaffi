import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AffiliateCommissionDetailView } from "@/app/affiliates/dashboard/commissions/AffiliateCommissionSheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/ui/badge", async () => {
  const { createElement } = await import("react");
  return {
    Badge: ({
      children,
      className,
    }: {
      children?: ReactNode;
      className?: string;
    }) => createElement("span", { className }, children),
  };
});

vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await import("react");
  const wrapper = ({
    children,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => createElement("div", props, children);

  return {
    Sheet: wrapper,
    SheetContent: wrapper,
    SheetHeader: wrapper,
    SheetTitle: ({ children }: { children?: ReactNode }) =>
      createElement("h1", null, children),
    SheetDescription: ({ children }: { children?: ReactNode }) =>
      createElement("p", null, children),
  };
});

vi.mock("@/app/affiliates/dashboard/commissions/CommissionLedger", () => ({
  STATUS_LABELS: {
    PENDING: "On hold",
    PAYABLE: "Payable",
    PAID: "Paid",
    VOIDED: "Voided",
  },
  STATUS_STYLES: {
    PENDING: "",
    PAYABLE: "",
    PAID: "",
    VOIDED: "",
  },
}));

import { AffiliateCommissionSheet } from "@/app/affiliates/dashboard/commissions/AffiliateCommissionSheet";

const seed = 0x5eedc0de;
const statuses: AffiliateCommissionDetailView["status"][] = [
  "PENDING",
  "PAYABLE",
  "PAID",
  "VOIDED",
];
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function seededRandom(initialSeed: number): () => number {
  let state = initialSeed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function dateLabel(day: number, monthIndex: number, monthOffset = 0): string {
  const month = months[(monthIndex + monthOffset) % months.length];
  return `${day} ${month} 2026`;
}

function fixtureFor(
  index: number,
  random: () => number,
): AffiliateCommissionDetailView {
  const status = statuses[random() % statuses.length];
  const day = (random() % 28) + 1;
  const monthIndex = random() % months.length;
  const checkingAvailability = random() % 2 === 0;
  const payableLabel = dateLabel(day, monthIndex, 1);
  const paidLabel = dateLabel(day, monthIndex, 2);
  const voidedLabel = dateLabel(day, monthIndex, 3);

  return {
    amount: `$${index + 1}.80 USD`,
    saleAmount: null,
    grossAmount: null,
    status,
    stateLabel:
      status === "PENDING"
        ? checkingAvailability
          ? "Checking availability"
          : `Available ${payableLabel}`
        : status === "PAID"
          ? `Paid ${paidLabel}`
          : status === "PAYABLE"
            ? "Ready to pay"
            : "Voided",
    createdLabel: dateLabel(day, monthIndex),
    payableLabel,
    paidLabel: status === "PAID" ? paidLabel : null,
    voidedLabel: status === "VOIDED" ? voidedLabel : null,
    linkCode: null,
    isAdjustment: false,
    voidReason: null,
    paymentProvider: null,
  };
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("affiliate commission detail date display fuzz", () => {
  it("shows each applicable date once in a labeled row for every status", () => {
    const random = seededRandom(seed);

    for (let index = 0; index < 128; index += 1) {
      const commission = fixtureFor(index, random);
      const html = renderToStaticMarkup(
        createElement(AffiliateCommissionSheet, {
          commission,
          listHref: "/affiliates/dashboard/commissions",
        }),
      );
      const context = JSON.stringify({ seed, index, commission });

      expect(occurrences(html, "Status"), context).toBe(1);
      expect(occurrences(html, commission.createdLabel), context).toBe(1);
      expect(occurrences(html, "Commission date"), context).toBe(1);
      expect(occurrences(html, "Commission ·"), context).toBe(0);

      if (commission.status === "PENDING") {
        expect(occurrences(html, "On hold"), context).toBe(1);
        if (commission.stateLabel === "Checking availability") {
          expect(occurrences(html, "Availability"), context).toBe(1);
          expect(occurrences(html, "Checking availability"), context).toBe(1);
          expect(occurrences(html, commission.payableLabel), context).toBe(0);
        } else {
          expect(occurrences(html, "Expected availability"), context).toBe(1);
          expect(occurrences(html, commission.payableLabel), context).toBe(1);
        }
      } else if (commission.status === "PAYABLE") {
        expect(occurrences(html, "Payable"), context).toBe(1);
      } else if (commission.status === "PAID") {
        expect(occurrences(html, "Paid"), context).toBe(1);
        expect(occurrences(html, "Paid on"), context).toBe(1);
        expect(occurrences(html, commission.paidLabel!), context).toBe(1);
      } else {
        expect(occurrences(html, "Voided"), context).toBe(1);
        expect(occurrences(html, "Voided on"), context).toBe(1);
        expect(occurrences(html, commission.voidedLabel!), context).toBe(1);
      }
    }
  });
});
