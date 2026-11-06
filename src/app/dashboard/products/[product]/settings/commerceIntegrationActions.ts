"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import type { ProductRef } from "@/lib/merchant";
import {
  rotateCommerceIntegrationSecret,
  setCommerceEventDestination,
} from "@/lib/commerceIntegrationAuth";

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
