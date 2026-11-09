"use client";

import { useActionState, useId, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/dashboard/Page";
import {
  PAYOUT_METHODS,
  composeCryptoPayoutDetails,
  composePayoutDetails,
  parseCryptoPayoutDetails,
  parsePayoutDetails,
  type PayoutMethod,
} from "@/lib/payoutMethod";
import { updatePayoutDetailsAction } from "./updatePayoutDetails";

const METHOD_LABELS = Object.fromEntries(
  Object.entries(PAYOUT_METHODS).map(([method, { label }]) => [method, label]),
) as Record<PayoutMethod, string>;

// Keep the other methods available for existing payout details and future
// re-enablement, while only offering crypto in the picker for now.
const VISIBLE_METHODS = ["crypto"] as const satisfies readonly PayoutMethod[];

type FormState = { error?: string; saved?: boolean };

async function submit(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = String(formData.get("payoutDetails") ?? "");
  const result = await updatePayoutDetailsAction(value);
  if (result.error) return { error: result.error };
  return { saved: true };
}

/**
 * Where the merchant sends the money: a method from a short list and the
 * details it needs, stored as a single line the owner can copy. "Other" keeps
 * the free text for anything the list does not name.
 *
 * The save action sits in the card's band, the way every task card in the
 * flow carries the one action it owns. The button reaches the form by
 * `form=` rather than by nesting, since the band and the body are siblings.
 */
export function PayoutDetailsForm({
  initial,
  className,
}: {
  initial: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(submit, {});
  const formId = useId();
  const parsedInitial = parsePayoutDetails(initial);
  const initialCrypto =
    parsedInitial.method === "crypto"
      ? parseCryptoPayoutDetails(parsedInitial.value)
      : { coinAndNetwork: "", walletAddress: "" };
  const [method, setMethod] = useState<PayoutMethod>(
    initial.trim() ? parsedInitial.method : "crypto",
  );
  const [value, setValue] = useState(() =>
    parsedInitial.method === "crypto"
      ? initialCrypto.walletAddress
      : parsedInitial.value,
  );
  const [cryptoCoinAndNetwork, setCryptoCoinAndNetwork] = useState(
    initialCrypto.coinAndNetwork,
  );
  const [cryptoWalletAddress, setCryptoWalletAddress] = useState(
    initialCrypto.walletAddress,
  );

  // From the prop alone: the action revalidates the layout, so `initial`
  // arrives filled in after a save and the notice goes with it. Saving an
  // empty field leaves it up next to "Saved", which is the truth.
  const missing = initial.trim() === "";
  const methodSelect = (
    <Select
      items={METHOD_LABELS}
      value={method}
      onValueChange={(next) => setMethod(next as PayoutMethod)}
    >
      <SelectTrigger
        className={
          method === "crypto"
            ? "h-9 w-full cursor-pointer"
            : "h-9 w-full shrink-0 cursor-pointer sm:w-40"
        }
        aria-label="Payout method"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VISIBLE_METHODS.map((key) => (
          <SelectItem key={key} value={key} className="cursor-pointer">
            {METHOD_LABELS[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Section
      title="Payout details"
      className={className}
      actions={
        <div className="flex items-center gap-2.5">
          {state.saved && (
            <span className="flex items-center gap-1 text-xs font-medium text-status-success">
              <Check className="size-3.5" />
              Saved
            </span>
          )}
          <Button
            type="submit"
            form={formId}
            size="sm"
            className="cursor-pointer"
            disabled={pending}
          >
            {pending ? "Saving" : "Save"}
          </Button>
        </div>
      }
    >
      <form id={formId} action={formAction} className="flex flex-col gap-2.5">
        {/* The one consequence this screen has that nothing on it shows: an
            empty field means the merchant has nowhere to send the money. Said
            here, where it is fixed, and nowhere else. */}
        {missing && (
          <p className="shrink-0 rounded-(--radius) bg-status-warning-bg px-3 py-2 text-[13px] text-status-warning">
            Until this is filled in, your merchant has nowhere to send your
            money.
          </p>
        )}
        <input
          type="hidden"
          name="payoutDetails"
          value={
            method === "crypto"
              ? composeCryptoPayoutDetails({
                  coinAndNetwork: cryptoCoinAndNetwork,
                  walletAddress: cryptoWalletAddress,
                })
              : composePayoutDetails(method, value)
          }
        />
        {method === "crypto" ? (
          <div className="grid items-end gap-x-3 gap-y-2 sm:grid-cols-2">
            {methodSelect}
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Coin and network
              <Input
                value={cryptoCoinAndNetwork}
                onChange={(e) => setCryptoCoinAndNetwork(e.target.value)}
                aria-label="Crypto coin and network"
                placeholder="e.g. USDC on Base"
                className="h-9"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              Wallet address
              <Input
                value={cryptoWalletAddress}
                onChange={(e) => setCryptoWalletAddress(e.target.value)}
                aria-label="Crypto wallet address"
                className="h-9 font-mono"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            {methodSelect}
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={METHOD_LABELS[method]}
              placeholder={PAYOUT_METHODS[method].placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="h-9"
            />
          </div>
        )}
        {state.error && (
          <p role="alert" className="shrink-0 text-[13px] text-status-danger">
            {state.error}
          </p>
        )}
      </form>
    </Section>
  );
}
