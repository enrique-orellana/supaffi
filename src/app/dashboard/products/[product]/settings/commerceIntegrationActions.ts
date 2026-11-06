"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { ProductRef } from "@/lib/merchant";
import {
  rotateCommerceIntegrationSecret,
  setCommerceEventDestination,
} from "@/lib/commerceIntegrationAuth";
import {
  reconcileCommerceCheckoutAsAbsent,
  reconcileCommerceCheckoutAsFound,
} from "@/lib/commerceCheckouts";

async function ownerId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

export async function rotateCommerceIntegrationSecretAction(
  product: ProductRef,
  _previous: { error: string; integrationId?: string; secret?: string },
  _formData: FormData
): Promise<{ error: string; integrationId?: string; secret?: string }> {
  const owner = await ownerId();
  try {
    const result = await rotateCommerceIntegrationSecret(owner, product.id);
    revalidatePath(`/dashboard/products/${product.slug}/settings`);
    return { error: "", ...result };
  } catch {
    return { error: "Unable to update this integration." };
  }
}

export async function saveCommerceEventDestinationAction(
  product: ProductRef,
  previous: { error: string; saved?: boolean },
  formData: FormData
): Promise<{ error: string; saved?: boolean }> {
  const owner = await ownerId();
  const destination = String(formData.get("eventDestination") ?? "");
  try {
    await setCommerceEventDestination(owner, product.id, destination);
    revalidatePath(`/dashboard/products/${product.slug}/settings`);
    return { error: "", saved: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Use an HTTPS URL on a public host." || message === "Create an integration secret first.") {
      return { error: message, saved: previous.saved };
    }
    return { error: "Unable to update this integration.", saved: previous.saved };
  }
}

export async function saveFoundCommerceInvoiceAction(
  product: ProductRef,
  checkoutId: string,
  _previous: { error: string },
  formData: FormData
): Promise<{ error: string }> {
  const owner = await ownerId();
  const invoiceRef = String(formData.get("invoiceRef") ?? "");
  const invoiceUrl = String(formData.get("invoiceUrl") ?? "");
  try {
    await reconcileCommerceCheckoutAsFound(owner, product.id, checkoutId, invoiceRef, invoiceUrl);
    revalidatePath(`/dashboard/products/${product.slug}/settings`);
    return { error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message === "Enter a valid NOWPayments invoice ID and hosted invoice URL."
    ) return { error: message };
    return { error: "Unable to reconcile this checkout. Refresh the page and try again." };
  }
}

export async function confirmNoCommerceInvoiceAction(
  product: ProductRef,
  checkoutId: string,
  _previous: { error: string },
  formData: FormData
): Promise<{ error: string }> {
  const owner = await ownerId();
  if (formData.get("confirmNoInvoice") !== "yes") {
    return { error: "Confirm that you checked the provider invoice list first." };
  }
  try {
    await reconcileCommerceCheckoutAsAbsent(owner, product.id, checkoutId);
    revalidatePath(`/dashboard/products/${product.slug}/settings`);
    return { error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message === "A provider invoice reference is already recorded. Reconcile that invoice instead." ||
      message === "Wait 15 minutes from the last update before confirming that no invoice exists."
    ) return { error: message };
    return { error: "Unable to reconcile this checkout. Refresh the page and try again." };
  }
}
