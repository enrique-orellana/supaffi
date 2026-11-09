"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/dashboard/Page";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwordPolicy";
import {
  DISPLAY_CURRENCY_OPTIONS,
  normalizeDisplayCurrency,
  type SupportedDisplayCurrency,
} from "@/lib/displayCurrencyOptions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  changeEmailAction,
  changePasswordAction,
  updateOwnerDisplayCurrencyAction,
} from "./accountActions";

/**
 * The two forms that change the account, each asking for the current password
 * before it will do anything: a session left open on a shared machine should
 * not be enough to take the account over.
 *
 * The confirmation under each one says what happens next rather than "saved",
 * because in both cases something the owner can see is now out of date: the
 * email in the sidebar until the next login, and the session itself the moment
 * the password changes.
 */

const EMPTY = { error: "", done: false };
const EMPTY_CURRENCY_STATE = { error: "", saved: false, savedCurrency: null };

export function DisplayCurrencyForm({
  currency,
}: {
  currency: SupportedDisplayCurrency;
}) {
  const [state, action, pending] = useActionState(
    updateOwnerDisplayCurrencyAction,
    EMPTY_CURRENCY_STATE,
  );
  const [value, setValue] = useState<SupportedDisplayCurrency>(currency);
  const showSaved = state.saved && value === state.savedCurrency;

  return (
    <form action={action} className="grid max-w-xl gap-4">
      <div className="grid gap-2">
        <Label htmlFor="owner-display-currency">Display currency</Label>
        <Select
          name="displayCurrency"
          value={value}
          onValueChange={(next) =>
            setValue(normalizeDisplayCurrency(next) ?? currency)
          }
        >
          <SelectTrigger
            id="owner-display-currency"
            className="h-9 w-full cursor-pointer"
            aria-label="Dashboard display currency"
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
        <p className="text-sm text-muted-foreground">
          Dashboard totals and charts use this currency when reference rates are
          available. Commissions, payouts, and program currencies keep their
          original values. Converted totals are estimates.
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
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  minLength,
  defaultValue,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  minLength?: number;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[9rem_1fr] sm:items-center sm:gap-4">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        minLength={minLength}
        defaultValue={defaultValue}
        className="sm:max-w-80"
        required
      />
    </div>
  );
}

function Result({
  state,
  done,
}: {
  state: { error: string; done: boolean };
  done: string;
}) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-status-danger">
        {state.error}
      </p>
    );
  }
  if (state.done)
    return <p className="text-sm text-muted-foreground">{done}</p>;
  return null;
}

function UsernameHint({ id, email }: { id: string; email: string }) {
  if (!email) return null;

  return (
    <div className="sr-only">
      <Label htmlFor={id}>Account email</Label>
      <Input
        id={id}
        name="username"
        type="text"
        autoComplete="username"
        value={email}
        readOnly
        tabIndex={-1}
      />
    </div>
  );
}

export function EmailForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(changeEmailAction, EMPTY);

  return (
    <Section title="Email">
      <form action={action} className="flex flex-col gap-4">
        <UsernameHint id="current-username-email" email={email} />
        <Field
          id="email"
          label="New email"
          type="email"
          autoComplete="email"
          defaultValue={email}
        />
        <Field
          id="password"
          label="Current password"
          type="password"
          autoComplete="current-password"
        />
        <Result state={state} done="Takes effect next time you log in." />
        <div>
          <Button
            type="submit"
            size="sm"
            className="cursor-pointer"
            disabled={pending}
          >
            {pending ? "Saving" : "Change email"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

export function PasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(changePasswordAction, EMPTY);

  return (
    <Section title="Password">
      <form action={action} className="flex flex-col gap-4">
        <UsernameHint id="password-username-email" email={email} />
        <Field
          id="current"
          label="Current password"
          type="password"
          autoComplete="current-password"
        />
        <Field
          id="next"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
        />
        <Result
          state={state}
          done="Password changed. You will be asked to log in again."
        />
        <div>
          <Button
            type="submit"
            size="sm"
            className="cursor-pointer"
            disabled={pending}
          >
            {pending ? "Saving" : "Change password"}
          </Button>
        </div>
      </form>
    </Section>
  );
}
