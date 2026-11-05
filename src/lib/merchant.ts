import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { uniqueSlug } from "@/lib/slug";

// Creating a Merchant no longer takes any credentials. Connecting Stripe is
// a separate step, done against a Merchant that
// already exists, so the Owner is never asked for a Stripe secret before
// they have been told what Supaffi does with it.
type MerchantDetailsInput = {
  name: string;
  domain: string;
  websiteUrl: string;
};

export async function createMerchant(
  ownerId: string,
  input: MerchantDetailsInput
): Promise<{ id: string; slug: string }> {
  const slug = await uniqueSlug(input.name, "product", async (candidate) =>
    Boolean(
      await db.merchant.findFirst({
        where: { ownerId, slug: candidate },
        select: { id: true },
      })
    )
  );

  return db.merchant.create({
    data: {
      ownerId,
      name: input.name,
      slug,
      domain: input.domain,
      websiteUrl: input.websiteUrl,
    },
    select: { id: true, slug: true },
  });
}

// Ownership check shared by every mutation below. findFirst scoped by both
// id and ownerId, not a bare findUnique(id) — this is what actually enforces
// ownership; an update scoped only by id would happily write to another
// Owner's Merchant.
async function assertOwns(ownerId: string, merchantId: string): Promise<void> {
  const existing = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { id: true },
  });
  if (!existing) {
    throw new Error("Merchant not found");
  }
}

// Fields are individually optional so re-connecting can rotate one secret
// without the caller having to re-send the other. An empty string is treated
// as "not provided", never encrypted over the top of a live credential.
export async function connectStripe(
  ownerId: string,
  merchantId: string,
  input: { secretKey?: string; webhookSecret?: string; webhookEndpointId?: string | null }
): Promise<void> {
  const newSecretKeyEnc = input.secretKey ? encrypt(input.secretKey) : undefined;
  const newWebhookSecretEnc = input.webhookSecret ? encrypt(input.webhookSecret) : undefined;

  await db.$transaction(async (tx) => {
    // Serialize rotations so the legacy and provider-neutral records are
    // derived from the same, latest ciphertexts.
    const merchants = await tx.$queryRaw<
      {
        id: string;
        stripeSecretKeyEnc: string | null;
        stripeWebhookSecretEnc: string | null;
        stripeWebhookEndpointId: string | null;
      }[]
    >`SELECT "id", "stripeSecretKeyEnc", "stripeWebhookSecretEnc", "stripeWebhookEndpointId"
      FROM "Merchant" WHERE "id" = ${merchantId} AND "ownerId" = ${ownerId} FOR UPDATE`;
    const merchant = merchants[0];
    if (!merchant) throw new Error("Merchant not found");

    const stripeSecretKeyEnc = newSecretKeyEnc ?? merchant.stripeSecretKeyEnc;
    const stripeWebhookSecretEnc = newWebhookSecretEnc ?? merchant.stripeWebhookSecretEnc;
    const stripeWebhookEndpointId = input.webhookEndpointId !== undefined
      ? input.webhookEndpointId
      : merchant.stripeWebhookEndpointId;
    const status = stripeSecretKeyEnc && stripeWebhookSecretEnc ? "CONNECTED" : "DISCONNECTED";

    await tx.merchant.update({
      where: { id: merchantId },
      data: {
        ...(newSecretKeyEnc !== undefined ? { stripeSecretKeyEnc: newSecretKeyEnc } : {}),
        ...(newWebhookSecretEnc !== undefined ? { stripeWebhookSecretEnc: newWebhookSecretEnc } : {}),
        // Explicit null clears it, which is what a manually pasted secret means:
        // the endpoint on the other end is one Supaffi did not create and must
        // not later delete.
        ...(input.webhookEndpointId !== undefined ? { stripeWebhookEndpointId: input.webhookEndpointId } : {}),
      },
    });

    await tx.paymentConnection.upsert({
      where: { merchantId_provider: { merchantId, provider: "STRIPE" } },
      create: {
        merchantId,
        provider: "STRIPE",
        apiKeyEnc: stripeSecretKeyEnc,
        webhookSecretEnc: stripeWebhookSecretEnc,
        externalEndpointId: stripeWebhookEndpointId,
        status,
        enabled: true,
      },
      update: {
        // Copy ciphertext unchanged when a different credential is rotated.
        apiKeyEnc: stripeSecretKeyEnc,
        webhookSecretEnc: stripeWebhookSecretEnc,
        externalEndpointId: stripeWebhookEndpointId,
        status,
      },
    });
  });
}

/** Clears both Stripe representations together; deleting an endpoint remotely
 * remains a separate operation because only Supaffi-created endpoints may be
 * removed on the owner's behalf. */
export async function disconnectStripe(ownerId: string, merchantId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const merchants = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Merchant"
      WHERE "id" = ${merchantId} AND "ownerId" = ${ownerId}
      FOR UPDATE
    `;
    if (!merchants[0]) throw new Error("Merchant not found");

    await tx.merchant.update({
      where: { id: merchantId },
      data: {
        stripeSecretKeyEnc: null,
        stripeWebhookSecretEnc: null,
        stripeWebhookEndpointId: null,
      },
    });
    await tx.paymentConnection.updateMany({
      where: { merchantId, provider: "STRIPE" },
      data: {
        apiKeyEnc: null,
        webhookSecretEnc: null,
        externalEndpointId: null,
        status: "DISCONNECTED",
        enabled: false,
      },
    });
  });
}

// Which integrations are live, without ever handing the ciphertext to a
// caller that only needs to render a checkmark.
//
// The two halves of Stripe are reported separately as well as together. A
// screen that treats "key and secret" as one thing cannot tell someone who
// has pasted the key and still owes the webhook secret where they are, and
// onboarding has a step for each.
export async function getIntegrationStatus(
  ownerId: string,
  merchantId: string
): Promise<{ stripe: boolean; stripeKey: boolean; stripeWebhook: boolean }> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { stripeSecretKeyEnc: true, stripeWebhookSecretEnc: true },
  });
  const stripeKey = Boolean(merchant?.stripeSecretKeyEnc);
  const stripeWebhook = Boolean(merchant?.stripeWebhookSecretEnc);
  return {
    stripe: stripeKey && stripeWebhook,
    stripeKey,
    stripeWebhook,
  };
}

export type StripeKeyKind = "restricted" | "secret" | null;

/**
 * What kind of Stripe key is on file, told apart by its prefix alone.
 *
 * `rk_` is what the pre-filled restricted-key link (stripeRestrictedKey.ts)
 * produces; `sk_` is a full account key pasted in some other way, which can
 * do far more than Supaffi needs and is worth the Owner's status screen
 * flagging. Decrypting is cheap (one AES block), and the plaintext never
 * leaves this function.
 */
export async function getStripeKeyKind(
  ownerId: string,
  merchantId: string
): Promise<StripeKeyKind> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { stripeSecretKeyEnc: true },
  });
  if (!merchant?.stripeSecretKeyEnc) return null;

  // A rotated or lost MASTER_ENCRYPTION_KEY makes decrypt throw. Integrations
  // is the one screen that exists to tell an Owner their Stripe connection is
  // broken, so it has to render and say so rather than 500 (CONTEXT.md: a
  // decrypt failure prompts a reconnect).
  let key: string;
  try {
    key = decrypt(merchant.stripeSecretKeyEnc);
  } catch {
    return null;
  }
  if (key.startsWith("rk_")) return "restricted";
  if (key.startsWith("sk_")) return "secret";
  return null;
}

export async function listMerchantsForOwner(
  ownerId: string
): Promise<
  { id: string; slug: string; name: string; domain: string; onboardingCompletedAt: Date | null }[]
> {
  return db.merchant.findMany({
    where: { ownerId },
    // onboardingCompletedAt so the product list can tell a product still being
    // set up from one that is running, without a second query per row.
    select: { id: true, slug: true, name: true, domain: true, onboardingCompletedAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * What a route hands to a Server Action: the id it acts on and the slug it
 * redirects back to. Both, because an action that only knew the slug would
 * have to re-resolve it, and one that only knew the id could not build the URL
 * the Owner should land on.
 */
export type ProductRef = { id: string; slug: string };

export type OwnedMerchant = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  websiteUrl: string;
  createdAt: Date;
};

/**
 * The endpoint Supaffi created, or null when there is none. Kept off
 * OwnedMerchant on purpose: that shape is the product's own details, read by
 * every dashboard route, and one Stripe implementation detail does not belong
 * in all of them.
 */
export async function getStripeWebhookEndpointId(
  ownerId: string,
  merchantId: string
): Promise<string | null> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { stripeWebhookEndpointId: true },
  });
  return merchant?.stripeWebhookEndpointId ?? null;
}

export async function getMerchantForOwner(
  ownerId: string,
  merchantId: string
): Promise<OwnedMerchant | null> {
  return db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: MERCHANT_FIELDS,
  });
}

// What every dashboard route under /dashboard/products/[product] resolves
// with. The URL carries the slug; everything below this call uses `.id`.
export async function getMerchantForOwnerBySlug(
  ownerId: string,
  slug: string
): Promise<OwnedMerchant | null> {
  return db.merchant.findFirst({
    where: { slug, ownerId },
    select: MERCHANT_FIELDS,
  });
}

const MERCHANT_FIELDS = {
  id: true,
  slug: true,
  name: true,
  domain: true,
  websiteUrl: true,
  createdAt: true,
} as const;

export async function updateMerchant(
  ownerId: string,
  merchantId: string,
  input: MerchantDetailsInput
): Promise<void> {
  await assertOwns(ownerId, merchantId);
  await db.merchant.update({
    where: { id: merchantId },
    data: {
      name: input.name,
      domain: input.domain,
      websiteUrl: input.websiteUrl,
    },
  });
}

export async function getMerchantByDomain(
  domain: string
): Promise<{ id: string; slug: string; name: string; domain: string; websiteUrl: string } | null> {
  return db.merchant.findUnique({
    where: { domain },
    select: { id: true, slug: true, name: true, domain: true, websiteUrl: true },
  });
}

/**
 * Deletes a product and its operational data in one ownership-checked
 * transaction. Live dependents are deleted explicitly in dependency order;
 * the database cascades only the owned Affiliate/Program subtree and imported
 * archive when the final Merchant row is deleted.
 */
export async function deleteMerchant(ownerId: string, merchantId: string): Promise<void> {
  await assertOwns(ownerId, merchantId);
  const affiliates = { affiliate: { merchantId } };
  await db.$transaction(async (tx) => {
    await tx.commission.deleteMany({ where: affiliates });
    // Points at the click, so it goes before clicks do.
    await tx.referredSubscription.deleteMany({ where: { merchantId } });
    await tx.paymentRecord.deleteMany({ where: { merchantId } });
    // Checkouts may point at clicks and provider connections; payment records
    // above may point at a checkout.
    await tx.commerceCheckout.deleteMany({ where: { merchantId } });
    await tx.commerceEventDelivery.deleteMany({ where: { merchantId } });
    await tx.click.deleteMany({ where: affiliates });
    await tx.affiliateLink.deleteMany({ where: affiliates });
    await tx.affiliateLoginToken.deleteMany({ where: affiliates });
    await tx.webhookEvent.deleteMany({ where: { merchantId } });
    await tx.commerceIntegration.deleteMany({ where: { merchantId } });
    await tx.paymentConnection.deleteMany({ where: { merchantId } });
    // Affiliates, Programs, import batches, and their immutable rows are
    // removed by the database's Merchant-delete cascades after all operational
    // dependents above have been cleaned up.
    await tx.merchant.delete({ where: { id: merchantId } });
  });
}

export async function getOnboardingState(
  ownerId: string,
  merchantId: string
): Promise<{ onboardingCompletedAt: Date | null; welcomeDismissedAt: Date | null }> {
  const merchant = await db.merchant.findFirst({
    where: { id: merchantId, ownerId },
    select: { onboardingCompletedAt: true, welcomeDismissedAt: true },
  });
  if (!merchant) throw new Error("Merchant not found");
  return merchant;
}

// Set once. Re-running onboarding to reconnect something must not make the
// product look freshly finished again.
export async function markOnboardingComplete(ownerId: string, merchantId: string): Promise<void> {
  await assertOwns(ownerId, merchantId);
  await db.merchant.updateMany({
    where: { id: merchantId, onboardingCompletedAt: null },
    data: { onboardingCompletedAt: new Date() },
  });
}

export async function dismissWelcome(ownerId: string, merchantId: string): Promise<void> {
  await assertOwns(ownerId, merchantId);
  await db.merchant.updateMany({
    where: { id: merchantId, welcomeDismissedAt: null },
    data: { welcomeDismissedAt: new Date() },
  });
}

