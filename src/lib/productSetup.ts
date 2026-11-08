import { db } from "@/lib/db";
import { listPaymentProviderSetups } from "@/lib/payments/setupRegistry";
import { PaymentProvider, type PaymentProviderId } from "@/lib/payments/types";
import { getTrackingStatus, type TrackingStatus } from "@/lib/tracking";

/**
 * Setup state for one product.
 *
 * Three steps, and they are the three things that have to be true before the
 * product can earn anybody anything: the tools are connected, the terms exist,
 * and the tracking is on the Owner's site.
 *
 * Recruiting an affiliate used to be a fourth step. It is not setup, it is
 * using the product, and counting it meant a fully working product read "3 of
 * 4" forever and kept an onboarding rail on screens that had stopped being
 * onboarding. It lives on as the empty state of the Affiliates screen.
 *
 * Adding the first product is the only step that belongs to the account rather
 * than to a product, so it is not here either: it happens on the dashboard
 * home, and everything after it happens on the product's own page.
 *
 * Both the home page's product list and the product page read this, so the two
 * screens cannot disagree about how far along a product is.
 */
export type ProductSetup = {
  stripeConnected: boolean;
  /** The Stripe secret key is on file, whether or not the webhook secret is. */
  stripeKeyStored: boolean;
  /** The Stripe webhook signing secret is on file, whether or not the key is. */
  stripeWebhookStored: boolean;
  /** At least one registered payment provider is connected. */
  integrationsConnected: boolean;
  /** Connected payment providers in registry order. */
  connectedPaymentProviders: PaymentProviderId[];
  firstProgramSlug: string | null;
  trackingStatus: TrackingStatus;
  /** Not a setup step. Cards read it; `doneCount` does not. */
  affiliateCount: number;
  /** Steps finished, out of `totalSteps`. */
  doneCount: number;
  totalSteps: number;
  /** Every step done. Setup is over and the step rail comes off every screen. */
  complete: boolean;
};

export const SETUP_STEP_COUNT = 3;

export async function getProductSetup(
  ownerId: string,
  merchantId: string,
): Promise<ProductSetup> {
  const paymentProviderSetups = listPaymentProviderSetups();
  const [providerStatuses, programs, trackingStatus, affiliateCount] =
    await Promise.all([
      Promise.all(
        paymentProviderSetups.map(async ({ provider, readStatus }) => ({
          provider,
          ...(await readStatus(ownerId, merchantId)),
        })),
      ),
      db.program.findMany({
        where: { merchantId },
        orderBy: { createdAt: "asc" },
        select: { slug: true, signupOpen: true },
      }),
      getTrackingStatus(merchantId),
      db.affiliate.count({ where: { merchantId } }),
    ]);

  const connectedPaymentProviders = providerStatuses
    .filter(({ connected }) => connected)
    .map(({ provider }) => provider);
  const integrationsConnected = connectedPaymentProviders.length > 0;
  const stripeStatus = providerStatuses.find(
    ({ provider }) => provider === PaymentProvider.STRIPE.id,
  );
  const stripeConnected = stripeStatus?.connected ?? false;
  const stripeDetails = stripeStatus?.details;
  const stripeKeyStored =
    stripeDetails && "keyStored" in stripeDetails
      ? stripeDetails.keyStored
      : false;
  const stripeWebhookStored =
    stripeDetails && "webhookStored" in stripeDetails
      ? stripeDetails.webhookStored
      : false;

  // Tracking counts as done once anything has been recorded, not once a sale
  // has proven the checkout half. Waiting on a stranger to buy something is not
  // a task, and holding setup open on it left every Owner permanently
  // unfinished through no fault of their own.
  const doneCount = [
    integrationsConnected,
    programs.length > 0,
    trackingStatus !== "not-started",
  ].filter(Boolean).length;

  return {
    stripeConnected,
    stripeKeyStored,
    stripeWebhookStored,
    integrationsConnected,
    connectedPaymentProviders,
    // The link handed out, so the first program anyone can still sign up to.
    firstProgramSlug: programs.find((p) => p.signupOpen)?.slug ?? null,
    trackingStatus,
    affiliateCount,
    doneCount,
    totalSteps: SETUP_STEP_COUNT,
    complete: doneCount === SETUP_STEP_COUNT,
  };
}
