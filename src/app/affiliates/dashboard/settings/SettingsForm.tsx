"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DISPLAY_CURRENCY_OPTIONS,
  PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
} from "@/lib/displayCurrencyOptions";
import {
  saveAffiliateDisplayCurrencyAction,
  type DisplayCurrencySettingsState,
} from "./actions";

const INITIAL_STATE: DisplayCurrencySettingsState = {
  error: "",
  saved: false,
  savedPreference: null,
};

export function SettingsForm({
  preference,
  programDefault,
}: {
  preference: string | null;
  programDefault: string;
}) {
  const [state, action, pending] = useActionState(
    saveAffiliateDisplayCurrencyAction,
    INITIAL_STATE,
  );
  const [value, setValue] = useState(
    preference ?? PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE,
  );
  const savedSelection =
    state.savedPreference ?? PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE;
  const showSaved = state.saved && value === savedSelection;

  return (
    <form action={action} className="grid gap-5">
      <div className="grid max-w-xl gap-2">
        <Label htmlFor="affiliate-display-currency">
          Dashboard display currency
        </Label>
        <Select
          name="displayCurrency"
          value={value}
          onValueChange={(next) =>
            setValue(String(next ?? PROGRAM_DEFAULT_DISPLAY_CURRENCY_VALUE))
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

      {state.error && (
        <p role="alert" className="text-sm text-status-danger">
          {state.error}
        </p>
      )}
      {showSaved && (
        <p role="status" className="text-sm text-status-success">
          Dashboard currency saved.
        </p>
      )}

      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
      </div>
    </form>
  );
}
