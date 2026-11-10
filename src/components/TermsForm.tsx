"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Field, FormCard } from "@/components/Field";
import { Term } from "@/components/Term";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ProgramActionState,
  ProgramFormValues,
} from "@/lib/programValidation";
import { COMMISSION_DURATION_OPTIONS } from "@/lib/commissionDuration";
import {
  MAX_COMMISSION_DURATION_MONTHS,
  MAX_COMMISSION_TERM_DAYS,
} from "@/lib/commissionTermLimits";
import {
  DEFAULT_DISPLAY_CURRENCY,
  DISPLAY_CURRENCY_OPTIONS,
} from "@/lib/displayCurrencyOptions";

type Action = (
  prev: ProgramActionState,
  formData: FormData,
) => Promise<ProgramActionState>;

export const TERMS_DEFAULTS: ProgramFormValues = {
  name: "",
  defaultCommissionRate: "20",
  commissionDurationType: "FOREVER",
  commissionDurationMonths: "",
  attributionWindowDays: "60",
  holdingPeriodDays: "30",
  currency: DEFAULT_DISPLAY_CURRENCY,
  minimumPayoutAmount: "0.00",
};

// Passed to the Select as `items` so the trigger shows the sentence rather
// than the raw enum name it submits.
const DURATIONS = Object.fromEntries(
  COMMISSION_DURATION_OPTIONS.map(({ value, label }) => [value, label]),
);
const DISPLAY_CURRENCIES = Object.fromEntries(
  DISPLAY_CURRENCY_OPTIONS.map(({ code, label }) => [code, label]),
);

const NUMBER = "w-20 tabular-nums";

/**
 * Labels above their fields on one card, the layout every form shares. Only
 * the two windows carry a qualifier, because they are the only labels here
 * that do not explain themselves.
 */
export function TermsForm({
  action,
  initial = TERMS_DEFAULTS,
  askName = true,
  signupOpen,
  submitLabel,
  confirmEdits = false,
}: {
  action: Action;
  initial?: ProgramFormValues;
  /** Off in onboarding: the first program takes the product's name. */
  askName?: boolean;
  /** Shown only where it is set: onboarding's first program is always open. */
  signupOpen?: boolean;
  submitLabel: string;
  confirmEdits?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { error: "" });
  const formRef = useRef<HTMLFormElement>(null);
  const [dismissedConfirmationState, setDismissedConfirmationState] =
    useState<ProgramActionState | null>(null);
  const confirmationOpen =
    Boolean(state.editConfirmation) && dismissedConfirmationState !== state;
  const values = { ...initial, ...state.values };
  const [duration, setDuration] = useState(values.commissionDurationType);
  const [currency, setCurrency] = useState(
    values.currency ?? DEFAULT_DISPLAY_CURRENCY,
  );
  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      <FormCard>
        {askName && (
          <Field label="Program name" htmlFor="program-name">
            <Input
              id="program-name"
              name="name"
              defaultValue={values.name}
              placeholder="Partners"
              required
            />
          </Field>
        )}

        <Field label="Commission" htmlFor="program-rate">
          <div className="flex items-center gap-2">
            <div className="relative shrink-0">
              <Input
                id="program-rate"
                name="defaultCommissionRate"
                type="number"
                min="1"
                max="100"
                step="1"
                defaultValue={values.defaultCommissionRate}
                required
                className="w-24 pr-7 tabular-nums"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                %
              </span>
            </div>
            <Select
              name="commissionDurationType"
              items={DURATIONS}
              value={duration}
              onValueChange={(value) => setDuration(String(value))}
            >
              <SelectTrigger
                className="h-9 min-w-0 flex-1 cursor-pointer"
                aria-label="How long commission is paid"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMISSION_DURATION_OPTIONS.map(({ value, label }) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="cursor-pointer"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>

        <Field
          label={
            <Term tip="Default for affiliate dashboards. Commission and payout records keep their original currencies.">
              Affiliate dashboard currency
            </Term>
          }
          htmlFor="program-currency"
        >
          <Select
            name="currency"
            items={DISPLAY_CURRENCIES}
            value={currency}
            onValueChange={(value) => setCurrency(String(value))}
          >
            <SelectTrigger
              id="program-currency"
              className="h-9 w-full cursor-pointer"
              aria-label="Default affiliate dashboard currency"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPLAY_CURRENCY_OPTIONS.map(({ code, label }) => (
                <SelectItem key={code} value={code} className="cursor-pointer">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={
            <Term tip="This is checked separately in each transaction currency, with no conversion. For example, 50 means 50 EUR and 50 USD. Set 0 to make every otherwise-clear mature commission payable.">
              Minimum balance before payout
            </Term>
          }
          htmlFor="program-minimum-payout"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              id="program-minimum-payout"
              name="minimumPayoutAmount"
              type="number"
              min="0"
              step="0.01"
              defaultValue={values.minimumPayoutAmount ?? "0.00"}
              required
              className="w-32 tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              Set 0 for no minimum. Applied independently to each transaction
              currency.
            </p>
          </div>
        </Field>

        {duration === "FIXED_MONTHS" && (
          <Field label="Months of renewals" htmlFor="program-months">
            <Input
              id="program-months"
              name="commissionDurationMonths"
              type="number"
              min="1"
              max={MAX_COMMISSION_DURATION_MONTHS}
              step="1"
              defaultValue={values.commissionDurationMonths || "12"}
              className={NUMBER}
            />
          </Field>
        )}

        {/* The same words the affiliate sees on their signup page, not the
            model's. What the number means sits behind the underline. */}
        <div className="grid grid-cols-2 gap-5">
          <Field
            label={
              <Term tip="A sale counts for the affiliate if it happens within this many days of their click.">
                Time to buy
              </Term>
            }
            htmlFor="program-window"
          >
            <div className="flex items-center gap-2">
              <Input
                id="program-window"
                name="attributionWindowDays"
                type="number"
                min="1"
                max={MAX_COMMISSION_TERM_DAYS}
                step="1"
                defaultValue={values.attributionWindowDays}
                required
                className={NUMBER}
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          </Field>

          <Field
            label={
              <Term tip="A commission waits this long before it is yours to pay, so a refund can still cancel it.">
                Hold before paying
              </Term>
            }
            htmlFor="program-hold"
          >
            <div className="flex items-center gap-2">
              <Input
                id="program-hold"
                name="holdingPeriodDays"
                type="number"
                min="1"
                max={MAX_COMMISSION_TERM_DAYS}
                step="1"
                defaultValue={values.holdingPeriodDays}
                required
                className={NUMBER}
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          </Field>
        </div>

        {signupOpen !== undefined && (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox
              name="signupOpen"
              defaultChecked={values.signupOpen ?? signupOpen}
              className="cursor-pointer"
            />
            <Term tip="Anyone with the signup link can join. Turn it off for a tier you move affiliates into yourself.">
              Public signup
            </Term>
          </label>
        )}
      </FormCard>

      {state.minimumConfirmation && (
        <input
          type="hidden"
          name="minimumConfirmationFingerprint"
          value={state.minimumConfirmation.fingerprint}
        />
      )}
      {confirmEdits && confirmationOpen && (
        <input type="hidden" name="confirmProgramChanges" value="yes" />
      )}
      {state.error && (
        <p role="alert" className="text-[13px] text-status-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          size="lg"
          className="cursor-pointer"
          disabled={pending}
        >
          {submitLabel}
        </Button>
      </div>

      {confirmEdits && (
        <Dialog
          open={confirmationOpen}
          onOpenChange={(open) => {
            if (!open) setDismissedConfirmationState(state);
          }}
        >
          <DialogContent
            showCloseButton
            className="max-h-[min(80vh,36rem)] max-w-md overflow-hidden"
          >
            <DialogHeader>
              <DialogTitle>Save Program changes?</DialogTitle>
              <DialogDescription>
                {state.minimumConfirmation
                  ? "Review the affected balances before saving the new payout minimum."
                  : "New referrals will use the updated Program terms. The default affiliate display currency and payout eligibility may also change."}
              </DialogDescription>
            </DialogHeader>
            {state.minimumConfirmation && (
              <section className="min-h-0 max-h-[35vh] space-y-3 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">Payout impact</h3>
                  <p className="text-xs text-muted-foreground">
                    New minimum: {state.values?.minimumPayoutAmount ?? "0.00"}{" "}
                    per transaction currency.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {state.minimumConfirmation.groupCount} balance
                    {state.minimumConfirmation.groupCount === 1 ? "" : "s"}{" "}
                    would move to pending. Currently payable:{" "}
                    {state.minimumConfirmation.currentlyPayableByCurrency
                      .map(
                        ({ currency: code, total }) =>
                          `${total} ${code.toUpperCase()}`,
                      )
                      .join(" · ")}
                    .
                  </p>
                </div>
                <ul className="divide-y divide-border text-sm">
                  {state.minimumConfirmation.examples.map((group) => (
                    <li
                      key={`${group.affiliateId}:${group.currency}`}
                      className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="min-w-0 truncate">
                        {group.affiliateName ?? "Affiliate"}
                      </span>
                      <span className="shrink-0 text-right tabular-nums">
                        {group.currentlyPayable} {group.currency.toUpperCase()}
                        <span className="block text-xs text-muted-foreground">
                          moving to pending; eligible {group.eligibleBalance}{" "}
                          {group.currency.toUpperCase()}
                        </span>
                      </span>
                    </li>
                  ))}
                  {state.minimumConfirmation.groupCount >
                    state.minimumConfirmation.examples.length && (
                    <li className="pt-2 text-xs text-muted-foreground">
                      and{" "}
                      {state.minimumConfirmation.groupCount -
                        state.minimumConfirmation.examples.length}{" "}
                      more balances
                    </li>
                  )}
                </ul>
              </section>
            )}
            <DialogFooter className="bg-popover">
              <DialogClose
                render={<Button type="button" variant="outline" />}
                disabled={pending}
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                onClick={() => formRef.current?.requestSubmit()}
                disabled={pending}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </form>
  );
}
