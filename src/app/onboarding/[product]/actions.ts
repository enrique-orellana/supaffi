"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import {
  getMerchantForOwner,
  updateMerchant,
  markOnboardingComplete,
} from "@/lib/merchant";
import {
  validateProductInput,
  normalizeDomain,
  normalizeWebsiteUrl,
} from "@/lib/productValidation";
import { instanceDomain } from "@/lib/instance";
import { isUniqueConstraintError } from "@/lib/prismaErrors";
import {
  stepPath,
  splitSubdomain,
  rehomeSubdomain,
  type StepId,
} from "@/lib/onboarding";
import {
  createProgram,
  updateProgram,
  listProgramsForMerchant,
} from "@/lib/program";
import {
  validateProgramInput,
  type ProgramActionState,
  type ProgramFormSnapshot,
} from "@/lib/programValidation";
import { summarizeProgramMinimumImpact } from "@/lib/payoutEligibility";
import { runProductChecks } from "@/lib/checks/product";
import { checkSectionFor } from "@/lib/onboarding";
import { getProductSetup } from "@/lib/productSetup";
import { listPaymentProviderSetups } from "@/lib/payments/setupRegistry";

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

/**
 * `savedAt` is what closes the inline editor and shows the confirmation. It
 * changes on every successful write, so saving the same value twice still
 * confirms rather than looking like nothing happened.
 */
export type EditResult = { error: string; savedAt?: number };

export async function updateSubdomainAction(
  product: { id: string; slug: string },
  _prev: EditResult,
  formData: FormData,
): Promise<EditResult> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");

  // The field only edits the label in front of the root when the stored
  // address sits under the product's own site. Where it does not, on a local
  // instance or for an address set by hand, the whole thing is edited.
  const split = splitSubdomain(merchant.domain, merchant.websiteUrl);
  const raw = String(formData.get("value") ?? "").trim();
  if (!raw) return { error: "This cannot be empty" };
  if (split && !/^[a-z0-9-]+$/i.test(raw)) {
    return { error: "Letters, numbers and dashes only" };
  }
  const domain = normalizeDomain(split ? `${raw}${split.suffix}` : raw);

  const error = validateProductInput(
    { name: merchant.name, domain, websiteUrl: merchant.websiteUrl },
    instanceDomain(),
  );
  if (error) return { error };

  try {
    await updateMerchant(ownerId, product.id, {
      name: merchant.name,
      domain,
      websiteUrl: merchant.websiteUrl,
    });
  } catch (err) {
    if (isUniqueConstraintError(err))
      return { error: "Another product already uses that address" };
    throw err;
  }
  // No revalidate here. Re-rendering the step from the action means the save
  // does not answer until every DNS check has run, which is three seconds of
  // a dead button. The field refreshes the page itself once it has its
  // answer, so the row confirms at once and the checks catch up behind it.
  return { error: "", savedAt: Date.now() };
}

export async function updateProductNameAction(
  product: { id: string; slug: string },
  _prev: EditResult,
  formData: FormData,
): Promise<EditResult> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");

  const name = String(formData.get("value") ?? "").trim();
  const error = validateProductInput(
    { name, domain: merchant.domain, websiteUrl: merchant.websiteUrl },
    instanceDomain(),
  );
  if (error) return { error };

  await updateMerchant(ownerId, product.id, {
    name,
    domain: merchant.domain,
    websiteUrl: merchant.websiteUrl,
  });
  revalidatePath(stepPath(product.slug, "product"));
  return { error: "", savedAt: Date.now() };
}

/**
 * Correcting the website moves the program's address with it, keeping any
 * label the owner chose. Someone who typed the wrong site during setup was
 * previously stuck with it: the product step redirected away from itself, so
 * there was no screen left that could fix this.
 */
export async function updateProductWebsiteAction(
  product: { id: string; slug: string },
  _prev: EditResult,
  formData: FormData,
): Promise<EditResult> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");

  const websiteUrl = normalizeWebsiteUrl(String(formData.get("value") ?? ""));
  const domain = normalizeDomain(
    rehomeSubdomain(merchant.domain, merchant.websiteUrl, websiteUrl),
  );
  const error = validateProductInput(
    { name: merchant.name, domain, websiteUrl },
    instanceDomain(),
  );
  if (error) return { error };

  try {
    await updateMerchant(ownerId, product.id, {
      name: merchant.name,
      domain,
      websiteUrl,
    });
  } catch (err) {
    if (isUniqueConstraintError(err))
      return { error: "Another product already uses that address" };
    throw err;
  }
  revalidatePath(stepPath(product.slug, "product"));
  // No revalidate here. Re-rendering the step from the action means the save
  // does not answer until every DNS check has run, which is three seconds of
  // a dead button. The field refreshes the page itself once it has its
  // answer, so the row confirms at once and the checks catch up behind it.
  return { error: "", savedAt: Date.now() };
}

export async function saveTermsAction(
  product: { id: string; slug: string },
  _prev: ProgramActionState,
  formData: FormData,
): Promise<ProgramActionState> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");
  // The step asks no name: the first program is named after the product,
  // and going back keeps whatever name it has since been given.
  const existing = await listProgramsForMerchant(ownerId, product.id);
  const values: ProgramFormSnapshot = {
    name: existing[0]?.name ?? merchant.name,
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
  };
  const result = validateProgramInput(values);
  if (result.error !== null) return { error: result.error, values };

  // The onboarding step edits the first program if one exists rather than
  // adding a second, so going back and changing a number does not leave a
  // trail of near identical programs.
  if (existing.length > 0) {
    const confirmed = formData.get("confirmMinimumChange") === "yes";
    const fingerprint = confirmed
      ? String(formData.get("minimumConfirmationFingerprint") ?? "")
      : null;
    const impact = await updateProgram(
      ownerId,
      product.id,
      existing[0].id,
      result.parsed,
      fingerprint,
    );
    if (impact) {
      return {
        error: "",
        values,
        minimumConfirmation: summarizeProgramMinimumImpact(impact),
      };
    }
  } else {
    await createProgram(ownerId, product.id, result.parsed);
  }
  redirect(stepPath(product.slug, "tracking"));
}

/**
 * "Check now": re-runs the step's own section instead of waiting for the
 * next 15 second tick. The section a step names is already run fresh on
 * every render (`checks.ts`), so revalidating the step's own path is enough;
 * there is no separate cache to invalidate here.
 */
export async function recheckAction(
  product: { id: string; slug: string },
  step: StepId,
): Promise<void> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");
  // Awaited, unlike the render's own run. This is the one moment the Owner
  // asked to be kept waiting, and the button spins while it happens, so
  // coming back with last minute's answer would be a lie.
  const section = checkSectionFor(step);
  const sections =
    step === "payments"
      ? new Set(
          listPaymentProviderSetups().flatMap(({ checkSections }) => [
            ...checkSections,
          ]),
        )
      : section
        ? new Set([section])
        : undefined;
  if (sections?.size)
    await runProductChecks(ownerId, product.id, { fresh: sections });
  revalidatePath(stepPath(product.slug, step));
}

export async function finishOnboardingAction(product: {
  id: string;
  slug: string;
}): Promise<void> {
  const ownerId = await owner();
  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");

  const setup = await getProductSetup(ownerId, product.id);
  if (setup.connectedPaymentProviders.length === 0) {
    redirect(stepPath(product.slug, "payments"));
  }

  await markOnboardingComplete(ownerId, product.id);
  revalidatePath("/dashboard", "layout");
  // Back to the step they were already on, which now renders the finished
  // modal over itself.
  revalidatePath(stepPath(product.slug, "tracking"));
  redirect(stepPath(product.slug, "tracking"));
}
