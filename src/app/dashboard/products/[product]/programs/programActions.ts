"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMerchantForOwnerBySlug } from "@/lib/merchant";
import type { ProgramInput } from "@/lib/program";
import { createProgram, updateProgram } from "@/lib/program";
import {
  validateProgramInput,
  type ProgramActionState,
  type ProgramFormSnapshot,
} from "@/lib/programValidation";
import {
  getProgramMinimumImpact,
  summarizeProgramMinimumImpact,
} from "@/lib/payoutEligibility";

/**
 * Creating and editing a program, from the sheet on the list. Both end on the
 * list with the sheet closed, which is what the redirect is for: the URL is
 * what opened the panel, so the URL is what has to close it.
 */

function read(formData: FormData):
  | { error: string; parsed?: undefined; values: ProgramFormSnapshot }
  | { error: null; parsed: ProgramInput; values: ProgramFormSnapshot } {
  const values: ProgramFormSnapshot = {
    name: String(formData.get("name") ?? ""),
    defaultCommissionRate: String(formData.get("defaultCommissionRate") ?? ""),
    commissionDurationType: String(
      formData.get("commissionDurationType") ?? "",
    ),
    commissionDurationMonths: String(
      formData.get("commissionDurationMonths") ?? "",
    ),
    attributionWindowDays: String(formData.get("attributionWindowDays") ?? ""),
    holdingPeriodDays: String(formData.get("holdingPeriodDays") ?? ""),
    currency: String(formData.get("currency") ?? ""),
    minimumPayoutAmount: String(formData.get("minimumPayoutAmount") ?? "0"),
    signupOpen: formData.get("signupOpen") === "on",
  };
  const result = validateProgramInput(values);
  if (result.error !== null) return { ...result, values };
  return {
    error: null,
    parsed: {
      ...result.parsed,
      signupOpen: values.signupOpen,
    },
    values,
  };
}

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

export async function createProgramAction(
  product: { id: string; slug: string },
  _prev: ProgramActionState,
  formData: FormData,
): Promise<ProgramActionState> {
  const ownerId = await owner();
  const result = read(formData);
  if (result.error !== null) return { error: result.error, values: result.values };
  await createProgram(ownerId, product.id, result.parsed);
  // The sidebar counts programs and is rendered by the dashboard layout, which
  // a soft navigation reuses from cache.
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/products/${product.slug}/programs`);
}

export async function updateProgramAction(
  product: { id: string; slug: string },
  programId: string,
  _prev: ProgramActionState,
  formData: FormData,
): Promise<ProgramActionState> {
  const ownerId = await owner();
  const result = read(formData);
  if (result.error !== null) return { error: result.error, values: result.values };
  const confirmed = formData.get("confirmProgramChanges") === "yes";
  if (!confirmed) {
    const merchant = await getMerchantForOwnerBySlug(ownerId, product.slug);
    if (!merchant || merchant.id !== product.id) {
      return { error: "Program not found.", values: result.values };
    }
    const existing = await db.program.findFirst({
      where: { id: programId, merchantId: merchant.id },
      select: { id: true },
    });
    if (!existing) return { error: "Program not found.", values: result.values };

    const impact = await getProgramMinimumImpact(
      merchant.id,
      programId,
      result.parsed.minimumPayoutAmount ?? "0",
    );
    return {
      error: "",
      values: result.values,
      editConfirmation: true,
      ...(impact.length > 0
        ? { minimumConfirmation: summarizeProgramMinimumImpact(impact) }
        : {}),
    };
  }

  const fingerprint = String(
    formData.get("minimumConfirmationFingerprint") ?? "",
  );
  const impact = await updateProgram(
    ownerId,
    product.id,
    programId,
    result.parsed,
    fingerprint,
  );
  if (impact) {
    return {
      error: "",
      values: result.values,
      editConfirmation: true,
      minimumConfirmation: summarizeProgramMinimumImpact(impact),
    };
  }
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/products/${product.slug}/programs`);
}
