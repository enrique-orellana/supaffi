import { db } from "@/lib/db";
import { COMMISSION_STATUS } from "@/lib/commissionStatus";
import { recalculatePayoutEligibility } from "@/lib/payoutEligibility";

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
  const now = new Date();
  const groups = await db.commission.findMany({
    where: {
      status: COMMISSION_STATUS.PENDING,
      payableAt: { lte: now },
      merchantId: { not: null },
      programId: { not: null },
      adjustsCommissionId: null,
      amount: { gt: 0 },
      payoutId: null,
      flagReason: null,
      disputeOpenedAt: null,
      checkoutConflictHeldAt: null,
    },
    distinct: ["merchantId", "affiliateId", "programId", "currency"],
    select: {
      merchantId: true,
      affiliateId: true,
      programId: true,
      currency: true,
    },
  });

  let changed = 0;
  for (const group of groups) {
    if (!group.merchantId || !group.programId) continue;
    const result = await db.$transaction((tx) =>
      recalculatePayoutEligibility(
        tx,
        {
          merchantId: group.merchantId!,
          affiliateId: group.affiliateId,
          programId: group.programId!,
          currency: group.currency,
        },
        now,
      ),
    );
    changed += result.changed;
  }
  return changed;
}
