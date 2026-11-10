// Owner commission actions return to the filtered list and only pass a
// bounded, trimmed note to the ledger.
import { describe, it, expect, vi, beforeEach } from "vitest";

const voidMock = vi.fn();
vi.mock("@/lib/commission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commission")>()),
  voidCommission: (...args: unknown[]) => voidMock(...args),
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

import { voidAction } from "@/app/dashboard/products/[product]/commissions/commissionActions";

const PRODUCT = { id: "m1", slug: "acme" };
const LIST = "/dashboard/products/acme/commissions?status=PAYABLE";

async function target(formData: FormData): Promise<string> {
  try {
    await voidAction(LIST, PRODUCT, "c1", formData);
  } catch (error) {
    return (error as Error).message.replace("redirect:", "");
  }
  throw new Error("no redirect");
}

describe("voidAction", () => {
  beforeEach(() => voidMock.mockReset());

  it("records the trimmed reason and returns to the filtered list", async () => {
    const formData = new FormData();
    formData.set("reason", "  duplicate order  ");

    expect(await target(formData)).toBe(LIST);
    expect(voidMock).toHaveBeenCalledWith(
      "owner-1",
      PRODUCT.id,
      "c1",
      "duplicate order",
    );
  });

  it("uses a safe default when the reason is blank", async () => {
    expect(await target(new FormData())).toBe(LIST);
    expect(voidMock).toHaveBeenCalledWith(
      "owner-1",
      PRODUCT.id,
      "c1",
      "voided by owner",
    );
  });
});
