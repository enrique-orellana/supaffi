import { PaymentProvider } from "@/lib/payments/types";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SqlSchema } from "@/lib/sqlSchema";

/**
 * Deletes processed webhook events older than 90 days, so the table stops
 * growing for as long as the install lives.
 *
 * Only PROCESSED rows go. PENDING and PROCESSING rows are still owed work,
 * and FAILED rows keep the error that explains a missing sale. Nothing reads
 * an old processed row: commissions and tracking verification live in their
 * own columns, and signed provider retries are not needed once an order is
 * settled. NOWPayments events for a checkout still marked UNCERTAIN are the
 * exception: owner reconciliation can replay their verified payload, so
 * those source rows stay until the checkout is resolved. The one reader of
 * "any row at all" is the settings light that says Stripe is sending events,
 * so each product's newest row is always kept.
 *
 * Batched, so a first run on an install with years of rows does not hold one
 * huge delete open against the table the webhook route is writing to. A run
 * stops after a fixed number of batches and carries on the next day.
 */
const RETENTION_DAYS = 90;
const BATCH_SIZE = 1_000;
const MAX_BATCHES = 100;

export async function cleanupProcessedEvents(
  now: Date = new Date(),
  options: { batchSize?: number } = {}
): Promise<number> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const deleted = await db.$executeRaw(Prisma.sql`
      WITH doomed AS (
        SELECT w.${SqlSchema.tables.WebhookEvent.id}
        FROM ${SqlSchema.tables.WebhookEvent.name} w
        WHERE w.${SqlSchema.tables.WebhookEvent.status} = 'PROCESSED'
          AND w.${SqlSchema.tables.WebhookEvent.createdAt} < ${cutoff}
          AND EXISTS (
            SELECT 1 FROM ${SqlSchema.tables.WebhookEvent.name} newer
            WHERE newer.${SqlSchema.tables.WebhookEvent.merchantId} = w.${SqlSchema.tables.WebhookEvent.merchantId}
              AND newer.${SqlSchema.tables.WebhookEvent.createdAt} > w.${SqlSchema.tables.WebhookEvent.createdAt}
          )
          AND NOT (
            w.${SqlSchema.tables.WebhookEvent.provider} = ${PaymentProvider.NOWPAYMENTS.database}::${SqlSchema.types.PaymentProvider}
            AND EXISTS (
              SELECT 1 FROM ${SqlSchema.tables.CommerceCheckout.name} checkout
              WHERE checkout.${SqlSchema.tables.CommerceCheckout.merchantId} = w.${SqlSchema.tables.WebhookEvent.merchantId}
                AND checkout.${SqlSchema.tables.CommerceCheckout.provider} = w.${SqlSchema.tables.WebhookEvent.provider}
                AND checkout.${SqlSchema.tables.CommerceCheckout.sourceOrderId} = w.${SqlSchema.tables.WebhookEvent.payload}->'rawPayload'->>'order_id'
                AND checkout.${SqlSchema.tables.CommerceCheckout.status} = 'UNCERTAIN'
            )
          )
        LIMIT ${batchSize}
      )
      DELETE FROM ${SqlSchema.tables.WebhookEvent.name} w
      USING doomed
      WHERE w.${SqlSchema.tables.WebhookEvent.id} = doomed.${SqlSchema.tables.WebhookEvent.id};
    `);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

// Started from the worker tick, so there is still one loop and one process.
// The time is held in memory, so a restart runs it again on the first tick,
// which is harmless: a second run the same day finds nothing to delete.
const CLEANUP_EVERY_MS = 24 * 60 * 60_000;

export type CleanupDeps = { cleanup: () => Promise<number>; now: () => number };

const defaults: CleanupDeps = { cleanup: () => cleanupProcessedEvents(), now: Date.now };

const schedule: { running: boolean; lastRunAt: number | null } = { running: false, lastRunAt: null };

/** For tests only: forgets when cleanup last ran. */
export function resetCleanupSchedule(): void {
  schedule.running = false;
  schedule.lastRunAt = null;
}

/**
 * Runs cleanup when a day has passed since the last run. Called on every
 * tick, so it returns at once when a run is going or nothing is due. Never
 * throws.
 */
export async function runDailyCleanup(deps: CleanupDeps = defaults): Promise<void> {
  if (schedule.running) return;
  const now = deps.now();
  if (schedule.lastRunAt !== null && now - schedule.lastRunAt < CLEANUP_EVERY_MS) return;
  // Stamped before the run, so a run that fails is not repeated every five
  // seconds by the next tick.
  schedule.lastRunAt = now;
  schedule.running = true;
  try {
    const deleted = await deps.cleanup();
    if (deleted > 0) {
      console.log(`[cleanup] removed ${deleted} processed webhook events older than 90 days`);
    }
  } catch (err) {
    console.error("[cleanup] could not remove old webhook events", err);
  } finally {
    schedule.running = false;
  }
}
