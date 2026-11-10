// markPayoutPaidAction passes only ledger result codes through the URL.
import { describe, it, expect, vi, beforeEach } from "vitest";

const markMock = vi.fn();
vi.mock("@/lib/commission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commission")>()),
  markCommissionsPaid: (...args: unknown[]) => markMock(...args),
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "owner-1", role: "owner" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import { markPayoutPaidAction } from "@/app/dashboard/products/[product]/payouts/payoutActions";

const PRODUCT = { id: "m1", slug: "acme" };
const BASE = "/dashboard/products/acme/payouts";

async function target(): Promise<string> {
  try {
    await markPayoutPaidAction(
      PRODUCT,
      [{ id: "c1", amount: "10.00" }],
      new Date().toISOString(),
    );
  } catch (error) {
    return (error as Error).message.replace("redirect:", "");
  }
  throw new Error("no redirect");
}

describe("markPayoutPaidAction", () => {
  beforeEach(() => markMock.mockReset());

  it("opens the Paid tab after recording a payout", async () => {
    markMock.mockResolvedValue({ count: 2, payoutId: "payout-1" });
    expect(await target()).toBe(`${BASE}?tab=paid`);
  });

  it("returns a fixed error code when the ledger refuses a payout", async () => {
    markMock.mockResolvedValue({ error: "stale" });
    expect(await target()).toBe(`${BASE}?error=stale`);
  });
});
