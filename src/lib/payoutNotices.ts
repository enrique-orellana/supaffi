import { PAYOUT_ERROR, STALE_PAGE } from "@/lib/commission";

/**
 * The refusals the ledger can hand back after Mark paid, as sentences. The
 * action puts a code in the URL rather than its own text, so the only thing a
 * form can do is pick one of these; a code that is not here is ignored rather
 * than shown.
 */
const REFUSALS: Record<string, string> = {
  [PAYOUT_ERROR.EMPTY]: "Nothing was selected, so there was nothing to pay.",
  [PAYOUT_ERROR.MIXED_GROUP]:
    "A payout covers one affiliate, one Program and one currency at a time.",
  [PAYOUT_ERROR.STALE_PAGE]: STALE_PAGE,
  [PAYOUT_ERROR.BELOW_MINIMUM]:
    "The selected commissions do not meet this Program’s payout minimum.",
  [PAYOUT_ERROR.CLOSEOUT]:
    "A closeout can include only mature, clear commissions held below the Program minimum.",
  [PAYOUT_ERROR.CLOSEOUT_REASON]: "Enter a reason for this closeout payout.",
  [PAYOUT_ERROR.INELIGIBLE]:
    "Some selected commissions changed or are no longer eligible. Refresh and try again.",
  [PAYOUT_ERROR.INVALID]: "The ledger refused that payout.",
};

export function refusalText(code: string | undefined): string | null {
  return code ? (REFUSALS[code] ?? null) : null;
}
