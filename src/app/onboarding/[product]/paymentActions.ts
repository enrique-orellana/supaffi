"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import {
  connectStripe,
  getMerchantForOwner,
  getStripeWebhookEndpointId,
} from "@/lib/merchant";
import {
  connectNowPayments,
  disconnectNowPayments,
  getNowPaymentsConnectionStatus,
} from "@/lib/paymentConnections";
import { stripeKeyWorks } from "@/lib/checks/stripe";
import { createWebhookEndpoint } from "@/lib/stripeWebhookEndpoint";
import { webhookEndpointUrl } from "@/lib/stripeWebhookLink";
import { isLocalDomain } from "@/lib/url";
import { nextStep, stepPath } from "@/lib/onboarding";
import { saveProviderFeeFallbackPercent } from "@/lib/providerFeeSettings";
import { PaymentProvider, type PaymentProviderId } from "@/lib/payments/types";
import type { ProviderFeeFallbackActionState } from "@/components/payments/ProviderFeeFallbackForm";

type ProductRef = { id: string; slug: string };
type ActionState = { error: string };

function providerDatabaseValue(
  provider: PaymentProviderId,
): "STRIPE" | "NOWPAYMENTS" | null {
  if (provider === PaymentProvider.STRIPE.id)
    return PaymentProvider.STRIPE.database;
  if (provider === PaymentProvider.NOWPAYMENTS.id)
    return PaymentProvider.NOWPAYMENTS.database;
  return null;
}

function parseFeeFallbackPercent(
  value: FormDataEntryValue | null,
): Prisma.Decimal | null {
  const text = String(value ?? "").trim();
  if (!/^(?:\d{1,3})(?:\.\d{1,2})?$/.test(text)) return null;
  const percent = new Prisma.Decimal(text);
  return percent.gte(0) && percent.lte(100) ? percent : null;
}

async function owner(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");
  return session.user.id;
}

export async function saveStripeKeyAction(
  product: ProductRef,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ownerId = await owner();
  const key = String(formData.get("value") ?? "").trim();
  const check = await stripeKeyWorks(key);
  if (!check.ok) return { error: check.detail };

  const merchant = await getMerchantForOwner(ownerId, product.id);
  if (!merchant) redirect("/onboarding");

  if (isLocalDomain(merchant.domain)) {
    await connectStripe(ownerId, product.id, { secretKey: key });
    revalidatePath(stepPath(product.slug, "payments"));
    return { error: "" };
  }

  const existingEndpoint = await getStripeWebhookEndpointId(
    ownerId,
    product.id,
  );
  if (existingEndpoint) {
    await connectStripe(ownerId, product.id, { secretKey: key });
  } else {
    const created = await createWebhookEndpoint({
      secretKey: key,
      url: webhookEndpointUrl(merchant.domain),
      productName: merchant.name,
    });
    if (!created.ok) {
      return {
        error:
          created.reason === "permission"
            ? "That key cannot create webhooks. Create it from the button above, with every row ticked."
            : created.detail,
      };
    }
    await connectStripe(ownerId, product.id, {
      secretKey: key,
      webhookSecret: created.secret,
      webhookEndpointId: created.id,
    });
  }

  revalidatePath(stepPath(product.slug, "payments"));
  const next = nextStep("payments");
  if (!next) redirect("/onboarding");
  redirect(stepPath(product.slug, next));
}

export async function saveWebhookSecretAction(
  product: ProductRef,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ownerId = await owner();
  const secret = String(formData.get("value") ?? "").trim();
  if (!secret.startsWith("whsec_"))
    return { error: "The signing secret starts with whsec_" };

  await connectStripe(ownerId, product.id, {
    webhookSecret: secret,
    webhookEndpointId: null,
  });
  revalidatePath(stepPath(product.slug, "payments"));
  return { error: "" };
}

export async function saveNowPaymentsOnboardingAction(
  product: ProductRef,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ownerId = await owner();
  const ipnSecret = String(formData.get("ipnSecret") ?? "").trim();

  const status = await getNowPaymentsConnectionStatus(ownerId, product.id);
  if (!status.hasIpnSecret && !ipnSecret)
    return {
      error: "Enter the NOWPayments IPN secret to verify signed notifications.",
    };
  await connectNowPayments(ownerId, product.id, {
    webhookSecret: ipnSecret,
  });
  revalidatePath(stepPath(product.slug, "payments"));
  return { error: "" };
}

export async function saveProviderFeeFallbackOnboardingAction(
  product: ProductRef,
  provider: PaymentProviderId,
  _prev: ProviderFeeFallbackActionState,
  formData: FormData,
): Promise<ProviderFeeFallbackActionState> {
  const ownerId = await owner();
  const databaseProvider = providerDatabaseValue(provider);
  const feeFallbackPercent = parseFeeFallbackPercent(
    formData.get("feeFallbackPercent"),
  );
  if (!databaseProvider || !feeFallbackPercent)
    return {
      error: "Enter a fee from 0 to 100, with up to two decimals.",
      success: false,
    };

  await saveProviderFeeFallbackPercent(
    ownerId,
    product.id,
    databaseProvider,
    feeFallbackPercent,
  );
  revalidatePath(stepPath(product.slug, "payments"));
  return { error: "", success: true };
}

export async function disconnectNowPaymentsOnboardingAction(
  product: ProductRef,
  _formData: FormData,
): Promise<void> {
  const ownerId = await owner();
  await disconnectNowPayments(ownerId, product.id);
  revalidatePath(stepPath(product.slug, "payments"));
}
