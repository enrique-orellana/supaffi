"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { markCommissionsPaid, type ShownCommission } from "@/lib/commission";

/**
 * One payout: the commissions on the row as shown, at the amounts shown, and
 * when the page was drawn. The ledger records those amounts; see
 * `markCommissionsPaid`. A refusal comes back in the URL as a fixed result
 * code that the page maps to a user-facing message.
 */
export async function markPayoutPaidAction(
  product: { id: string; slug: string },
  shown: ShownCommission[],
  renderedAt: string,
  formData?: FormData,
): Promise<void> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  const noteEntry = formData?.get("note");
  const note = typeof noteEntry === "string" ? noteEntry.trim() || null : null;
  const exceptionEntry = formData?.get("exceptionReason");
  const exceptionReason =
    typeof exceptionEntry === "string" ? exceptionEntry : null;
  const result = await markCommissionsPaid(
    session.user.id,
    product.id,
    shown,
    renderedAt,
    note,
    exceptionReason,
  );

  const params = new URLSearchParams();
  if ("error" in result) params.set("error", result.error);
  else {
    if (result.count > 0) params.set("tab", "paid");
  }
  const search = params.toString();
  revalidatePath("/dashboard", "layout");
  redirect(
    `/dashboard/products/${product.slug}/payouts${search ? `?${search}` : ""}`,
  );
}
