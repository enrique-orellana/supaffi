import { db } from "@/lib/db";

/**
 * How far along the tracking integration is.
 *
 * Three states rather than done/not-done, because the integration has two
 * halves that are proven at different times. The script on the Merchant's site
 * proves itself the moment anyone clicks a referral link. The
 * the Referral Token through on their Checkout Session cannot be proven until
 * somebody actually buys something, which the Owner cannot make happen on
 * demand and should not sit waiting for.
 *
 * So `awaiting-sale` is a real answer, not a fudged completion: clicks are
 * being recorded, the checkout half is still unproven, and the Owner is free
 * to go and recruit affiliates in the meantime.
 */
export type TrackingStatus = "not-started" | "awaiting-sale" | "verified";

/**
 * A live commission can prove a completed attributed checkout even when an
 * older payment-provider handler did not write `trackingVerifiedAt`.
 * Imported history is stored separately and deliberately does not count.
 */
async function firstAttributedSaleAt(merchantId: string): Promise<Date | null> {
  const commission = await db.commission.findFirst({
    where: { click: { merchantId }, adjustsCommissionId: null },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return commission?.createdAt ?? null;
}

export async function getTrackingStatus(
  merchantId: string,
): Promise<TrackingStatus> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { trackingVerifiedAt: true },
  });
  if (!merchant) return "not-started";

  // The column is the fast path. A live commission is a backstop for providers
  // that recorded the attributed sale before writing this timestamp existed.
  if (merchant.trackingVerifiedAt ?? (await firstAttributedSaleAt(merchantId)))
    return "verified";

  const click = await db.click.findFirst({
    where: { affiliate: { merchantId } },
    select: { id: true },
  });
  return click ? "awaiting-sale" : "not-started";
}

export type TrackingTimestamps = {
  /** The most recent Click on this Merchant, of any age. Not the 30 day
   * window `getProductMetrics` draws its chart from: the status screen wants
   * the actual last click, not "none in the last month". */
  lastClickAt: Date | null;
  /** The stored verification time, or the first live attributed sale as a
   * fallback for provider records created before the marker was written. */
  verifiedAt: Date | null;
};

/** The two dates the tracking status screen shows: last click, last sale. */
export async function getTrackingTimestamps(
  merchantId: string,
): Promise<TrackingTimestamps> {
  const [merchant, lastClick] = await Promise.all([
    db.merchant.findUnique({
      where: { id: merchantId },
      select: { trackingVerifiedAt: true },
    }),
    db.click.findFirst({
      where: { affiliate: { merchantId } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const verifiedAt =
    merchant?.trackingVerifiedAt ??
    (merchant ? await firstAttributedSaleAt(merchantId) : null);
  return {
    lastClickAt: lastClick?.createdAt ?? null,
    verifiedAt,
  };
}

/**
 * Records that a checkout arrived carrying a Referral Token.
 *
 * Called from the webhook worker on every attributed checkout, but only the
 * first one writes: the `trackingVerifiedAt: null` guard makes this a no-op
 * from the second sale onwards, so the timestamp keeps meaning "the first
 * time" and the celebration keyed off it cannot be re-triggered.
 */
export async function recordTrackingVerified(
  merchantId: string,
): Promise<void> {
  await db.merchant.updateMany({
    where: { id: merchantId, trackingVerifiedAt: null },
    data: { trackingVerifiedAt: new Date() },
  });
}

/**
 * The one render that celebrates: verified, and the Owner has not been told.
 *
 * Separate from `TrackingStatus` because it is about what the Owner has seen,
 * not about what is true of the integration.
 */
export async function shouldCelebrateTracking(
  merchantId: string,
): Promise<boolean> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { trackingVerifiedAt: true, trackingVerifiedSeenAt: true },
  });
  const verifiedAt =
    merchant?.trackingVerifiedAt ??
    (merchant ? await firstAttributedSaleAt(merchantId) : null);
  return Boolean(verifiedAt && !merchant?.trackingVerifiedSeenAt);
}

/**
 * Spends the moment. Scoped by `trackingVerifiedSeenAt: null` so two tabs
 * rendering at once cannot overwrite each other's stamp with a later one.
 */
export async function markTrackingCelebrationSeen(
  merchantId: string,
): Promise<void> {
  await db.merchant.updateMany({
    where: { id: merchantId, trackingVerifiedSeenAt: null },
    data: { trackingVerifiedSeenAt: new Date() },
  });
}

const RECENT_CLICK_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the last click is from the past week. */
export function clickedRecently(
  lastClickAt: Date | null,
  now: number = Date.now(),
): boolean {
  return lastClickAt !== null && now - lastClickAt.getTime() < RECENT_CLICK_MS;
}
