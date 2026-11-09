# Program minimum payout design

## Goal

Let each affiliate Program set the minimum accumulated commission balance an Affiliate must reach before a payout can be recorded. Keep the rule understandable in the owner dashboard and affiliate portal, preserve the program that earned each commission, and make grouped payouts auditable.

## Current behavior

A Commission records its Affiliate, referral Click, amount, currency, holding-period date, and status. The Affiliate has a mutable `programId`; the Click snapshots some program terms but does not retain the Program ID. Moving an Affiliate can therefore make older commissions appear to belong to the Affiliate's current Program. The schema is in `prisma/schema.prisma`.

A worker moves mature, unblocked commissions from `PENDING` to `PAYABLE`. Owner actions can also resolve flags and disputes. The payout view groups payable commissions by Affiliate and currency. Marking commissions paid updates selected Commission rows; Supaffi records the owner's confirmation and does not send money. There is no operational Payout batch model today.

## User experience

### Program settings

Add **Minimum balance before payout** to Program creation and editing, including onboarding where the shared terms form is used. Accept a non-negative amount with two decimal places. `0` means no minimum and preserves current behavior. Explain that the amount is checked separately in each transaction currency using the same numeric threshold (for example, 50 USD or 50 EUR); Supaffi does not convert currencies.

Show the minimum in public signup terms and in the Affiliate portal so Affiliates can understand the payout rule before joining and while tracking earnings.

When an Owner changes a minimum, show a confirmation if the change would put an Affiliate's currently payable balance on hold. The changed minimum applies to all unpaid commissions assigned to the Program. Paid history never changes.

### Commission status

Keep the existing statuses and explain the reason for `PENDING` in context:

- **On hold · waiting period** — show the commission's availability date.
- **On hold · below minimum** — show the Affiliate's eligible balance, the Program minimum, and the remaining amount needed.
- **On hold · under review** — show the appropriate dispute, self-referral, or checkout-conflict explanation.
- **Payable** — show when the affiliate/program/currency balance meets the minimum.
- **Paid** — show the paid date and payout record.

A commission may have completed its own holding period and still be on hold because the Affiliate's balance is below the Program minimum.

### Payouts

Show payout work in groups keyed by **Affiliate + Program + currency**. Each group shows its currently payable amount, commissions included, and any amount still on hold. A group can be expanded to inspect the commission rows, but paying is an action on the group rather than a required sequence of single-row actions.

The Owner sends the money outside Supaffi, then records one payout batch for that Affiliate, Program, and currency. The record stores the amount, date, selected whole Commission rows, and optional payment method, external reference, or note. One payout batch may include multiple commissions, and one payout batch never combines different Affiliates, Programs, or currencies. A batch records a completed external payment; it does not initiate a transfer.

The payout screen may filter or label batches by payout period. A calendar period is for organizing payment runs and reports; it does not erase or reset unpaid balances. Unpaid commissions carry forward across periods. Disabling an Affiliate or archiving a Program does not erase its unpaid commissions. An Owner may make an explicit below-minimum closeout payout for mature, otherwise-clear commissions; the Owner must provide a reason, and the batch is marked as an exception.

## Balance and eligibility rules

For each Affiliate, Program, and currency, calculate the eligible unpaid balance from positive Commission rows that:

1. Are not paid or voided and are not adjustment rows.
2. Have reached `payableAt`.
3. Have no open dispute or checkout-conflict hold.
4. Are not flagged for review.

The balance is the sum of these eligible rows. When it is at least the Program's minimum, the eligible rows become `PAYABLE`. Otherwise, mature eligible rows stay `PENDING` with the reason **below minimum**. A minimum of zero makes every mature, otherwise-clear commission payable.

A normal payout batch must include whole payable commissions totaling at least the current Program minimum. This prevents a small selected payout from bypassing the threshold. An explicit closeout exception may pay mature, otherwise-clear commissions below the minimum when an Affiliate is being closed, a Program is being archived, or the Owner approves another documented exception. The exception requires a reason and appears clearly in the payout history. Disputes, flags, and checkout-conflict holds cannot be bypassed by this exception. After recording a batch, mark its commissions `PAID`, then recalculate that Affiliate/Program/currency balance. Any remaining mature rows below the minimum return to `PENDING` with the below-minimum reason. The remaining balance carries forward and can qualify when later eligible commissions arrive.

Example: with a $50 minimum, mature cleared commissions of $30 and $25 total $55 and become payable. If the Owner records a payout containing $55 of commissions, the unpaid balance is $0. If the group has $90 and the Owner pays whole commissions totaling $60, the remaining $30 is held until later eligible commissions bring the balance to at least $50.

Each commission's holding period is evaluated independently. Immature commissions do not count toward the minimum. Flagged, disputed, conflict-held, paid, voided, and negative adjustment rows do not count. No amounts are combined across currencies and no FX conversion is performed.

## Data and architecture

- Add `Program.minimumPayoutAmount` as a decimal amount defaulting to `0`; migrate all existing Programs to `0`.
- Add an immutable Program association to each new referral Click, captured when the Click is created. Commissions inherit the Program from that Click, so later Affiliate reassignment does not move old earned commissions.
- Add an operational `Payout` batch record with merchant, Affiliate, Program, currency, total, paid date, optional method/reference/note, and the related Commission rows. Enforce that every batch belongs to exactly one Affiliate, Program, and currency. Retain each Commission's `PAID` status and `paidAt` for existing list and analytics behavior.
- Existing Clicks lack historical Program IDs. Backfill them using each Affiliate's current Program assignment. Exact historical assignments cannot be reconstructed for Affiliates who have moved Programs; this limitation must be stated in the migration notes. Since existing Programs default to zero, the rollout itself does not change eligibility.
- Use one shared server-side eligibility calculation. Re-evaluate affected groups when commissions mature, a flag or dispute is resolved, a conflict hold is released, a commission is voided, a payout is recorded, or a Program minimum changes. Run payout validation and status updates transactionally so two payout actions cannot spend the same eligible balance.
- Index the fields used to find open commissions by Program, Affiliate, currency, status, and availability date, following the database's supported index patterns.

## Failure handling and safety

Only record a payout after the Owner confirms the external transfer succeeded. If an external transfer fails, leave commissions payable and do not create a completed payout batch. Validate that a normal batch contains payable commissions for the authenticated merchant and exactly one Affiliate, Program, and currency. A closeout exception may include mature otherwise-clear commissions held only by the minimum when closing an Affiliate or archiving a Program; require a non-empty reason and mark the batch as an exception. Reject unresolved review holds, duplicate or already-paid commissions. Keep the update to the payout record and commission statuses atomic.

Changing a Program minimum immediately re-evaluates unpaid balances. Raising it may move mature commissions from `PAYABLE` back to `PENDING`; the confirmation must identify the affected groups. Lowering it can make groups payable immediately. Paid and voided rows are never reopened by a threshold change.

## Commission-rate ownership feedback

The current rate precedence is Program default, optional Affiliate-specific override, then optional AffiliateLink override. The link editor exposes the last override so a campaign link can have a different rate. In the supplied screenshot, both rate fields say **Inherit** and explain that they inherit 20%, so those links do not currently have separate rates.

For the intended product model, commission rate is a Program term and referral links should inherit it; the per-link commission-rate override should be removed. The current Affiliate-level custom rate is a separate exception mechanism. Recommendation: retain it only for explicitly negotiated Affiliate exceptions, with the effective rate shown in Affiliate settings. If the rule is strict that every Affiliate in a Program has the same rate, remove that override too and use a separate Program for each rate tier.

Existing Clicks keep their stored rate snapshots. Before link overrides stop affecting future Clicks, the Owner should be shown which active links have a custom rate so those exceptions can be reviewed. The time-to-buy, hold period, and commission-duration controls shown per link are separate overrides and are not changed by this rate decision.
## Scope

This design adds per-Program payout minimums, stable Program attribution for new referral activity, grouped payout records, and clear eligibility reasons. It does not add automatic money transfers, scheduled payout automation, currency conversion, split payments of a single Commission, or a new tax/withholding system.

## Acceptance criteria

1. New and existing Programs have a valid minimum amount; existing Programs default to zero.
2. The minimum is evaluated independently for each Affiliate, Program, and currency.
3. Immature, flagged, disputed, conflict-held, paid, voided, and adjustment commissions do not incorrectly satisfy the minimum.
4. Mature eligible commissions become payable when the accumulated balance reaches the minimum and remain clearly on hold below it.
5. The Owner can record one payout for multiple whole payable commissions belonging to the same Affiliate, Program, and currency.
6. A normal payout below the configured minimum, a mixed-group payout, or a payout containing an already-paid commission is rejected; a below-minimum closeout exception requires a reason and cannot include commissions with unresolved holds.
7. After a payout, paid commissions leave the unpaid balance and any below-minimum remainder carries forward.
8. Program reassignment does not change the Program association of new commissions created from earlier referral Clicks.
9. Program-setting, signup, owner commission, payout, and affiliate portal views explain the minimum and the reason for holds.
10. No money transfer or currency conversion is initiated by recording a payout.

## Verification plan

Review the new-program default, minimum validation, and the full flow for zero, below-minimum, exactly-at-minimum, and above-minimum balances. Check separate Affiliate and currency buckets, each hold reason, threshold increases and decreases, grouped payout recording, duplicate payout rejection, carry-forward after a payout, documented below-minimum closeout exception, and historical Click backfill. Confirm paid rows stay final and no external transfer is attempted.
