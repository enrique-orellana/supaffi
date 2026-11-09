import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { SqlSchema } from "@/lib/sqlSchema";

// Runs on the same tick as the webhook drain, with no new infrastructure.
// Deliberately WHERE status = 'PENDING' only: FLAGGED commissions are
// excluded on purpose, a flag blocks progress to PAYABLE until a Merchant
// confirms or dismisses it (that confirm/dismiss action, built elsewhere,
// is what flips a row away from FLAGGED so this sweep can then pick it up).
//
// A commission held by an open dispute stays PENDING however long the dispute
// takes. Closing it in the merchant's favour releases it (disputes.ts), and a
// lost one voids it, so nothing here needs to wait for either.
export async function sweepPayableCommissions(): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE ${SqlSchema.tables.Commission.name}
    SET ${SqlSchema.tables.Commission.status} = ${COMMISSION_STATUS.PAYABLE}::${SqlSchema.types.CommissionStatus}
    WHERE ${SqlSchema.tables.Commission.status} = ${COMMISSION_STATUS.PENDING}::${SqlSchema.types.CommissionStatus}
      AND ${SqlSchema.tables.Commission.payableAt} <= now()
      AND ${SqlSchema.tables.Commission.disputeOpenedAt} IS NULL
      AND ${SqlSchema.tables.Commission.checkoutConflictHeldAt} IS NULL;
  `);
}
