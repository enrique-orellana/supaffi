import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/commerce/checkouts/route";

describe("POST /api/commerce/checkouts", () => {
  it("returns 410 because Supaffi no longer creates the merchant's checkouts", async () => {
    const response = await POST(
      new Request("https://supaffi.example/api/commerce/checkouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceOrderId: "existing-order-1" }),
      }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("existing checkout"),
    });
  });
});
