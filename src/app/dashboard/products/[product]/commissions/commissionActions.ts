"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { safeListHref } from "@/lib/commissionRedirect";
import {
  confirmCommissionFraud,
  dismissCommissionFlag,
  voidCommission,
} from "@/lib/commission";

/**
 * The three writes the ledger makes, all of them from a form on a
 * server-rendered panel: the sheet holds no copy of a commission, so every
 * action ends by landing back on the list and letting it draw itself again.
 *
 * "Back" is the list the Owner was looking at, tab and filters and page
 * included, so an action does not quietly drop them onto the unfiltered ledger.
 * The page builds that URL and binds it to the form, and `safeListHref` checks
 * it before the redirect: a bound argument is a value the browser posts, so it
 * is not trusted to be a URL on this list at all.
 */

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

function back(product: { slug: string }, listHref: string): never {
  const list = `/dashboard/products/${product.slug}/commissions`;
  const target = safeListHref(listHref, list);
  revalidatePath("/dashboard", "layout");
  redirect(target);
}

export async function confirmFraudAction(
  listHref: string,
  product: { id: string; slug: string },
  id: string,
): Promise<void> {
  await confirmCommissionFraud(await owner(), product.id, id);
  back(product, listHref);
}

export async function dismissFlagAction(
  listHref: string,
  product: { id: string; slug: string },
  id: string,
): Promise<void> {
  await dismissCommissionFlag(await owner(), product.id, id);
  back(product, listHref);
}

export async function voidAction(
  listHref: string,
  product: { id: string; slug: string },
  id: string,
  formData: FormData,
): Promise<void> {
  // Capped: the reason is read back months later in a table cell, and the
  // field is a free text input on a page anybody with the session can post to.
  const reason =
    String(formData.get("reason") ?? "")
      .trim()
      .slice(0, 200) || "voided by owner";
  await voidCommission(await owner(), product.id, id, reason);
  back(product, listHref);
}
