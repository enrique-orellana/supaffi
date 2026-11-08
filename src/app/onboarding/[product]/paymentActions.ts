"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import {
  connectStripe,
  getMerchantForOwner,
  getStripeWebhookEndpointId,
} from "@/lib/merchant";
import {
  connectNowPayments,
  disconnectNowPayments,
  getNowPaymentsConnectionStatus,
  testNowPaymentsLookupAccess,
} from "@/lib/paymentConnections";
import { stripeKeyWorks } from "@/lib/checks/stripe";
import { createWebhookEndpoint } from "@/lib/stripeWebhookEndpoint";
import { webhookEndpointUrl } from "@/lib/stripeWebhookLink";
import { isLocalDomain } from "@/lib/url";
import { nextStep, stepPath } from "@/lib/onboarding";

type ProductRef = { id: string; slug: string };
type ActionState = { error: string };

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
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const ipnSecret = String(formData.get("ipnSecret") ?? "").trim();
  const apiAccountEmail = String(formData.get("apiAccountEmail") ?? "").trim();
  const apiAccountPassword = String(formData.get("apiAccountPassword") ?? "");
  const hasAccountEmail = Boolean(apiAccountEmail);
  const hasAccountPassword = Boolean(apiAccountPassword.trim());
  if (hasAccountEmail !== hasAccountPassword)
    return { error: "Enter both the NOWPayments account email and password." };

  const status = await getNowPaymentsConnectionStatus(ownerId, product.id);
  if (!status.connected && !apiKey)
    return { error: "Enter the NOWPayments API key." };
  if (!status.invoiceLookupReady && !hasAccountEmail)
    return {
      error:
        "Enter a NOWPayments account with payment viewing access to enable invoice checks.",
    };
  if (status.connected && !apiKey && !ipnSecret && !hasAccountEmail)
    return { error: "Enter at least one credential to update." };

  if (apiKey || hasAccountEmail) {
    try {
      await testNowPaymentsLookupAccess(ownerId, product.id, {
        apiKey,
        accountEmail: apiAccountEmail,
        accountPassword: apiAccountPassword,
      });
    } catch {
      return {
        error:
          "Supaffi could not verify payment-list access. Check the login and its NOWPayments viewing permissions.",
      };
    }
  }

  await connectNowPayments(ownerId, product.id, {
    apiKey,
    webhookSecret: ipnSecret,
    apiAccountEmail,
    apiAccountPassword,
  });
  revalidatePath(stepPath(product.slug, "payments"));
  return { error: "" };
}

export async function disconnectNowPaymentsOnboardingAction(
  product: ProductRef,
  _formData: FormData,
): Promise<void> {
  const ownerId = await owner();
  await disconnectNowPayments(ownerId, product.id);
  revalidatePath(stepPath(product.slug, "payments"));
}
