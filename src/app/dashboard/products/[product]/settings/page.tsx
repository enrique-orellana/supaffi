import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMerchantForOwnerBySlug, getStripeKeyKind } from "@/lib/merchant";
import { getCommerceIntegrationStatus } from "@/lib/commerceIntegrationAuth";
import { getUncertainCommerceCheckouts } from "@/lib/commerceCheckouts";
import { runProductChecks, type CheckSection } from "@/lib/checks/product";
import { restrictedKeyUrl } from "@/lib/stripeRestrictedKey";
import { Page, PageTitle, Section } from "@/components/dashboard/Page";
import { CheckList } from "@/components/onboarding/CheckList";
import { dnsCheckRows, type CheckRow } from "@/components/onboarding/checkRows";
import { isDevInstance } from "@/lib/instanceMode";
import { isLocalDomain } from "@/lib/url";
import { ProductForm } from "./ProductForm";
import { ConnectionSheet } from "./ConnectionSheet";
import { DeleteProduct } from "./DeleteProduct";
import { CommerceIntegrationCard } from "./CommerceIntegrationCard";
import { PaymentProvider } from "@/lib/payments/types";
import { listPaymentProviderSetups } from "@/lib/payments/setupRegistry";
import {
  replaceStripeKeyAction,
  replaceWebhookSecretAction,
} from "./settingsActions";

/**
 * The three things a product owns that are not affiliates: its details, its
 * credentials and its own existence.
 *
 * The lights are live rather than a stored flag, so a key revoked in Stripe
 * this morning says so here this afternoon. `runProductChecks` serves a
 * section it ran less than a minute ago from its cache, which is what keeps
 * this page off Stripe on every visit. `?fresh=<section>` is how a
 * write says its section is worth re-running: without it the light for the
 * thing just replaced would keep reading from a result taken before the fix.
 *
 * Replacing a credential opens the matching sheet from `?replace=`, which is
 * where the two connect screens and the four routes that used to lead to them
 * ended up.
 */

const SECTIONS: CheckSection[] = ["dns", PaymentProvider.STRIPE.id, "tracking"];

/** A section name in the URL, or nothing when it names none. */
function freshSection(raw: string | undefined): CheckSection | null {
  return SECTIONS.find((section) => section === raw) ?? null;
}

function checkoutPageNumber(raw: string | undefined): number {
  if (!raw || !/^\d{1,9}$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ product: string }>;
  searchParams: Promise<{ replace?: string; fresh?: string; checkoutPage?: string }>;
}) {
  const { product } = await params;
  const query = await searchParams;
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "owner") redirect("/login");

  const ownerId = session.user.id;
  const merchant = await getMerchantForOwnerBySlug(ownerId, product);
  if (!merchant) notFound();

  const fresh = freshSection(query.fresh);
  const providerSetups = listPaymentProviderSetups();
  const [checks, keyKind, paymentStatuses, commerceIntegration, uncertainCheckoutPage] = await Promise.all([
    runProductChecks(ownerId, merchant.id, fresh ? { fresh: new Set([fresh]) } : {}),
    getStripeKeyKind(ownerId, merchant.id),
    Promise.all(providerSetups.map(async (setup) => ({
      setup,
      status: await setup.readStatus(ownerId, merchant.id),
    }))),
    getCommerceIntegrationStatus(ownerId, merchant.id),
    getUncertainCommerceCheckouts(ownerId, merchant.id, checkoutPageNumber(query.checkoutPage)),
  ]);
  const local = isDevInstance() || isLocalDomain(merchant.domain);

  const productRef = { id: merchant.id, slug: merchant.slug };
  const settingsHref = `/dashboard/products/${merchant.slug}/settings`;
  const checkoutPageHref = (page: number) => {
    const params = new URLSearchParams();
    if (query.replace) params.set("replace", query.replace);
    if (query.fresh) params.set("fresh", query.fresh);
    params.set("checkoutPage", String(page));
    return `${settingsHref}?${params.toString()}`;
  };

  const dnsRows: CheckRow[] = local ? [] : dnsCheckRows(checks.dns);

  const sheets = {
    "stripe-key": {
      title: "Replace the Stripe key",
      lede: "Read only. Nothing is charged or created.",
      createLabel: "Create key in Stripe",
      createUrl: restrictedKeyUrl(merchant.name),
      fieldLabel: "Paste the new key",
      placeholder: "rk_live_...",
      action: replaceStripeKeyAction.bind(null, productRef),
    },
    "stripe-webhook": {
      title: "Replace the signing secret",
      lede: "Stripe signs every event it sends with this.",
      createLabel: "Open Stripe webhooks",
      createUrl: "https://dashboard.stripe.com/webhooks",
      fieldLabel: "Paste the signing secret",
      placeholder: "whsec_...",
      action: replaceWebhookSecretAction.bind(null, productRef),
    },
  } as const;

  // A value that names no sheet opens none, rather than an empty panel.
  const sheet = query.replace && query.replace in sheets
    ? sheets[query.replace as keyof typeof sheets]
    : null;

  return (
    <Page>
      <PageTitle title="Settings" subtitle={merchant.name} />

      <Section title="Product">
        <ProductForm
          product={productRef}
          initial={{
            name: merchant.name,
            domain: merchant.domain,
            websiteUrl: merchant.websiteUrl,
          }}
          lights={dnsRows.length > 0 ? <CheckList rows={dnsRows} /> : null}
        />
      </Section>

      <Section title="Connections" flush>
        <div className="divide-y divide-neutral-200">
          {paymentStatuses.map(({ setup, status }) => {
            const Panel = setup.panel;
            return (
              <div key={setup.provider} className="px-5 py-4">
                <Panel
                  provider={setup.provider}
                  label={setup.label}
                  product={merchant}
                  status={status}
                  surface="settings"
                  local={local}
                  checks={checks}
                  stripeKeyKind={keyKind}
                />
              </div>
            );
          })}
        </div>
        <div className="px-5 py-4">
          <CommerceIntegrationCard
            product={productRef}
            integrationId={commerceIntegration.integrationId}
            configured={commerceIntegration.configured}
            eventDestination={commerceIntegration.eventDestination}
            uncertainCheckouts={uncertainCheckoutPage.checkouts}
            uncertainCheckoutPage={uncertainCheckoutPage.page}
            uncertainCheckoutPageCount={uncertainCheckoutPage.pageCount}
            uncertainCheckoutTotal={uncertainCheckoutPage.totalCount}
            previousUncertainCheckoutHref={
              uncertainCheckoutPage.page > 0 ? checkoutPageHref(uncertainCheckoutPage.page - 1) : null
            }
            nextUncertainCheckoutHref={
              uncertainCheckoutPage.page + 1 < uncertainCheckoutPage.pageCount
                ? checkoutPageHref(uncertainCheckoutPage.page + 1)
                : null
            }
          />
        </div>
      </Section>

      <Section title="Danger">
        <DeleteProduct product={productRef} name={merchant.name} />
      </Section>

      {sheet && (
        <ConnectionSheet
          title={sheet.title}
          lede={sheet.lede}
          createLabel={sheet.createLabel}
          createUrl={sheet.createUrl}
          fieldLabel={sheet.fieldLabel}
          placeholder={sheet.placeholder}
          action={sheet.action}
          settingsHref={settingsHref}
        />
      )}
    </Page>
  );
}
