import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SqlSchema } from "@/lib/sqlSchema";

/**
 * Writes a commission unless the Owner has confirmed its referral as a self
 * referral, checked again at the moment of writing.
 *
 * The handlers check the click when an event starts, then spend seconds on
 * Stripe reads before they write. A confirmation landing in that window voided
 * the click's unpaid rows before this one existed, so the new row earned. The
 * click is held for share while it is read and the row written, and
 * `confirmCommissionFraud` takes the same click for update before it voids:
 * either the confirmation waits and then voids this row, or this waits and
 * then finds the click confirmed.
 *
 * Returns whether a row was written. A payment already recorded still throws
 * the unique constraint error the callers treat as a redelivery.
 */
export async function createCommissionUnlessSelfReferral(args: {
  data: Prisma.CommissionUncheckedCreateInput;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const [click] = await tx.$queryRaw<
      { fraudConfirmedAt: Date | null }[]
    >(Prisma.sql`
      SELECT ${SqlSchema.tables.Click.fraudConfirmedAt}
      FROM ${SqlSchema.tables.Click.name}
      WHERE ${SqlSchema.tables.Click.id} = ${args.data.clickId}
      FOR SHARE
    `);
    if (!click || click.fraudConfirmedAt !== null) return false;
    await tx.commission.create(args);
    return true;
  });
}
