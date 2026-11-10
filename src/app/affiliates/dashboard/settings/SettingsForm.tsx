"use client";

import { useActionState, useCallback, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/dashboard/Page";
import {
  DISPLAY_CURRENCY_OPTIONS,
  PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
} from "@/lib/displayCurrencyOptions";
import { PayoutDetailsFields } from "../PayoutDetailsFields";
import {
  saveAffiliateSettingsAction,
  type AffiliateSettingsState,
} from "./actions";

const INITIAL_STATE: AffiliateSettingsState = {
  error: "",
  saved: false,
  savedPayoutDetails: null,
  savedDisplayCurrency: null,
};

export function SettingsForm({
  payoutDetails: initialPayoutDetails,
  preference,
  programDefault,
}: {
  payoutDetails: string;
  preference: string | null;
  programDefault: string;
}) {
  const [state, formAction, pending] = useActionState(
    saveAffiliateSettingsAction,
    INITIAL_STATE,
  );
  const [payoutDetails, setPayoutDetails] = useState(initialPayoutDetails);
  const [displayCurrency, setDisplayCurrency] = useState(
    preference ?? PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
  );
  const handlePayoutDetailsChange = useCallback((value: string) => {
    setPayoutDetails(value);
  }, []);
  const showSaved =
    state.saved &&
    state.savedPayoutDetails === payoutDetails &&
    state.savedDisplayCurrency === displayCurrency;

  return (
    <form action={formAction} className="grid gap-5">
      <PayoutDetailsFields
        initial={initialPayoutDetails}
        onDetailsChange={handlePayoutDetailsChange}
      />

      <Section title="Display currency">
        <div className="grid max-w-xl gap-2">
          <Label htmlFor="affiliate-display-currency">
            Dashboard display currency
          </Label>
          <Select
            name="displayCurrency"
            value={displayCurrency}
            onValueChange={(next) =>
              setDisplayCurrency(
                String(next ?? PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE),
              )
            }
          >
            <SelectTrigger
              id="affiliate-display-currency"
              className="h-9 w-full cursor-pointer"
              aria-label="Dashboard display currency"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value={PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE}
                className="cursor-pointer"
              >
                Use program default ({programDefault.toUpperCase()})
              </SelectItem>
              {DISPLAY_CURRENCY_OPTIONS.map(({ code, label }) => (
                <SelectItem key={code} value={code} className="cursor-pointer">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            The program default is {programDefault.toUpperCase()}. Your choice
            applies across this affiliate portal. Commission and payout records
            keep their original currencies; converted amounts are estimates.
          </p>
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-live="polite">
          {state.error ? (
            <p role="alert" className="text-sm text-status-danger">
              {state.error}
            </p>
          ) : (
            showSaved && (
              <p
                role="status"
                className="flex items-center gap-1.5 text-sm text-status-success"
              >
                <Check className="size-4" />
                Settings saved.
              </p>
            )
          )}
        </div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Saving" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
