"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ProviderFeeFallbackActionState = {
  error: string;
  success?: boolean;
};

type FeeFallbackAction = (
  previousState: ProviderFeeFallbackActionState,
  formData: FormData,
) => Promise<ProviderFeeFallbackActionState>;

export function ProviderFeeFallbackForm({
  action,
  id,
  value,
}: {
  action: FeeFallbackAction;
  id: string;
  value: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: "",
    success: false,
  });

  return (
    <form action={formAction} className="grid gap-2">
      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor={id}>Fallback processing fee (%)</Label>
          <Input
            id={id}
            name="feeFallbackPercent"
            type="number"
            min="0"
            max="100"
            step="0.01"
            inputMode="decimal"
            required
            defaultValue={value ?? ""}
            placeholder="For example, 3.5"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Saving" : "Save fee"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The affiliate rate is applied after this fee. Supaffi uses the actual
        transaction fee when available; this estimate is used when it isn’t.
      </p>
      {value === null && (
        <p className="text-xs text-status-warning">
          No fallback is set. If a provider doesn’t report a fee, Supaffi will
          currently use 0% until you set one here.
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-status-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-status-success">
          Fallback fee saved.
        </p>
      )}
    </form>
  );
}
