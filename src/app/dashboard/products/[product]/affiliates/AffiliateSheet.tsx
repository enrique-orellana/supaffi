"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { originFor } from "@/lib/url";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import type { CommissionDurationType } from "@prisma/client";
import type { CommissionStatus } from "@/lib/commission";
import {
  COMMISSION_DURATION_OPTIONS,
  CommissionDuration,
  commissionDurationLabel,
} from "@/lib/commissionDuration";
import {
  MAX_COMMISSION_DURATION_MONTHS,
  MAX_COMMISSION_TERM_DAYS,
} from "@/lib/commissionTermLimits";
import {
  createPasswordLinkAction,
  saveAffiliateSettingsAction,
} from "./affiliateActions";

/**
 * Everything about one affiliate, in one place, without leaving the list.
 *
 * The list selects with `?affiliate=<id>` and the panel is rendered on the
 * server from that, so there is no client copy of an affiliate to keep in step
 * with a write. Closing is a navigation back to the list, which is why the URL
 * it returns to arrives as a prop: the filters and the page were already in it.
 */

export type SheetAffiliate = {
  id: string;
  name: string | null;
  email: string;
  joinedAt: string;
  programId: string;
  programTerms: {
    programId: string;
    commissionRateOverride: string | null;
    minimumPayoutAmountOverride: string | null;
    commissionDurationTypeOverride: CommissionDurationType | null;
    commissionDurationMonthsOverride: number | null;
    attributionWindowDaysOverride: number | null;
    holdingPeriodDaysOverride: number | null;
  }[];
  hasLegacyTermOverrides: boolean;
  payoutDetails: string | null;
  hasPassword: boolean;
  links: {
    id: string;
    url: string;
    clicks: number;
  }[];
  commissions: {
    id: string;
    date: string;
    amount: string;
    status: CommissionStatus;
  }[];
};

export type SheetProgram = {
  id: string;
  name: string;
  rate: string;
  commissionDurationType: CommissionDurationType;
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  minimumPayoutAmount: string;
};

export function AffiliateSheet({
  affiliate,
  productDomain,
  programs,
  product,
  listHref,
}: {
  affiliate: SheetAffiliate;
  /** The product's affiliate domain, where a password link has to be opened. */
  productDomain: string;
  programs: SheetProgram[];
  product: { id: string; slug: string };
  listHref: string;
}) {
  const router = useRouter();
  const formKey = JSON.stringify({
    programId: affiliate.programId,
    programTerms: affiliate.programTerms,
    hasLegacyTermOverrides: affiliate.hasLegacyTermOverrides,
    links: affiliate.links.map((link) => link.id),
  });

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(listHref);
      }}
    >
      <SheetContent className="flex w-[420px] flex-col overflow-hidden data-[side=right]:sm:max-w-[420px]">
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle className="truncate">
            {affiliate.name ?? affiliate.email}
          </SheetTitle>
          <SheetDescription className="truncate">
            {affiliate.email} · joined {affiliate.joinedAt}
          </SheetDescription>
        </SheetHeader>

        <AffiliateSettingsForm
          key={formKey}
          affiliate={affiliate}
          productDomain={productDomain}
          programs={programs}
          product={product}
        />
      </SheetContent>
    </Sheet>
  );
}

function AffiliateSettingsForm({
  affiliate,
  productDomain,
  programs,
  product,
}: {
  affiliate: SheetAffiliate;
  productDomain: string;
  programs: SheetProgram[];
  product: { id: string; slug: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingFormData = useRef<FormData | null>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState(
    affiliate.programId,
  );
  const selectedProgram = programs.find(
    (program) => program.id === selectedProgramId,
  );

  function cancelChanges() {
    formRef.current?.reset();
    pendingFormData.current = null;
    setConfirmationOpen(false);
    setSelectedProgramId(affiliate.programId);
    setError("");
  }

  function saveChanges(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    pendingFormData.current = new FormData(event.currentTarget);
    setConfirmationOpen(true);
  }

  function confirmChanges() {
    const formData = pendingFormData.current;
    if (!formData) return;
    startTransition(async () => {
      const result = await saveAffiliateSettingsAction(
        product,
        affiliate.id,
        formData,
      );
      if ("error" in result) {
        setError(result.error);
        return;
      }
      pendingFormData.current = null;
      setConfirmationOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <form
        ref={formRef}
        onSubmit={saveChanges}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-5">
          <section className="space-y-4">
            <h3 className="text-sm font-medium">Program terms</h3>

            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Program</span>
              <select
                name="programId"
                value={selectedProgramId}
                onChange={(event) => setSelectedProgramId(event.target.value)}
                className={SELECT_FIELD}
              >
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </label>

            {selectedProgram && (
              <AffiliateProgramTermFields
                key={selectedProgram.id}
                program={selectedProgram}
                overrides={
                  affiliate.programTerms.find(
                    (terms) => terms.programId === selectedProgram.id,
                  ) ?? null
                }
              />
            )}
            {affiliate.hasLegacyTermOverrides && (
              <p className="rounded-md border border-status-warning/30 bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
                Old link-specific settings are still stored, but no longer apply
                to new referrals. Existing clicks keep the terms saved when they
                were created.
              </p>
            )}
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium">Payout</h3>
            <p className="text-sm text-muted-foreground">
              {affiliate.payoutDetails ?? "No payout details provided yet."}
            </p>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Password</h3>
              {affiliate.hasPassword ? (
                <span className="text-sm text-muted-foreground">Set</span>
              ) : (
                <span className="text-sm text-status-warning">Not set</span>
              )}
            </div>
            <PasswordLink
              affiliateId={affiliate.id}
              hasPassword={affiliate.hasPassword}
              product={product}
              domain={productDomain}
            />
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <div>
              <h3 className="text-sm font-medium">Referral links</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Links only set the destination and referral code. All terms
                above apply across every link for this affiliate.
              </p>
            </div>

            {affiliate.links.length === 0 ? (
              <p className="text-sm text-muted-foreground">No links yet.</p>
            ) : (
              <ul className="space-y-3">
                {affiliate.links.map((link) => (
                  <li
                    key={link.id}
                    className="flex min-w-0 items-center justify-between gap-3 border-t border-border/70 pt-3 first:border-t-0 first:pt-0"
                  >
                    <code className="min-w-0 truncate font-mono text-xs text-foreground">
                      {link.url}
                    </code>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
                      {link.clicks} clicks
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium">Recent commissions</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {affiliate.commissions.length === 0 && (
                <li className="text-muted-foreground">None yet</li>
              )}
              {affiliate.commissions.map((commission) => (
                <li key={commission.id} className="flex items-center gap-3">
                  <span className="w-16 text-muted-foreground tabular-nums">
                    {commission.date}
                  </span>
                  <span className="flex-1 text-right tabular-nums">
                    {commission.amount}
                  </span>
                  <span className="flex w-20 justify-end">
                    <StatusBadge status={commission.status} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="shrink-0 border-t border-border bg-background px-4 py-3">
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={cancelChanges}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </form>
      <Dialog
        open={confirmationOpen}
        onOpenChange={(open) => {
          setConfirmationOpen(open);
          if (!open) {
            pendingFormData.current = null;
            setError("");
          }
        }}
      >
        <DialogContent showCloseButton className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save affiliate changes?</DialogTitle>
            <DialogDescription>
              Review the Program assignment and terms for{" "}
              {affiliate.name ?? affiliate.email}. New referrals will use the
              updated settings; existing clicks keep their saved terms.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <DialogFooter className="bg-popover">
            <DialogClose
              render={<Button type="button" variant="outline" />}
              disabled={pending}
            >
              Cancel
            </DialogClose>
            <Button type="button" onClick={confirmChanges} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AffiliateProgramTermFields({
  program,
  overrides,
}: {
  program: SheetProgram;
  overrides: SheetAffiliate["programTerms"][number] | null;
}) {
  const [durationOverride, setDurationOverride] = useState<string>(
    overrides?.commissionDurationTypeOverride ?? "inherit",
  );

  return (
    <>
      <section className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <ProgramTerm
            label="Commission"
            value={`${program.rate}% ${commissionDurationLabel(program.commissionDurationType, program.commissionDurationMonths)}`}
          />
          <ProgramTerm
            label="Time to buy"
            value={`${program.attributionWindowDays} days`}
          />
          <ProgramTerm
            label="Hold before paying"
            value={`${program.holdingPeriodDays} days`}
          />
          <ProgramTerm
            label="Minimum payable"
            value={
              Number(program.minimumPayoutAmount) === 0
                ? "No minimum"
                : `${program.minimumPayoutAmount} per currency`
            }
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          These are the Program defaults. Existing clicks keep the terms saved
          when they were created.
        </p>
      </section>

      <section className="space-y-4 border-t border-border pt-5">
        <div>
          <h3 className="text-sm font-medium">
            Affiliate terms for {program.name}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Blank fields use the Program default. These overrides apply to all
            of this affiliate&apos;s links in this Program.
          </p>
        </div>

        <Field label="Commission rate" htmlFor="affiliate-rate-override">
          <div className="relative">
            <Input
              id="affiliate-rate-override"
              name="commissionRateOverride"
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              defaultValue={overrides?.commissionRateOverride ?? ""}
              placeholder={`Program: ${program.rate}%`}
              className="pr-8 tabular-nums"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
              %
            </span>
          </div>
        </Field>

        <Field
          label="Commission duration"
          htmlFor="affiliate-duration-override"
        >
          <select
            id="affiliate-duration-override"
            name="commissionDurationTypeOverride"
            value={durationOverride}
            onChange={(event) => setDurationOverride(event.target.value)}
            className={SELECT_FIELD}
          >
            <option value="inherit">
              Use Program default ·{" "}
              {durationOptionLabel(
                program.commissionDurationType,
                program.commissionDurationMonths,
              )}
            </option>
            {COMMISSION_DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === CommissionDuration.FOREVER
                  ? "Every payment, forever"
                  : option.value === CommissionDuration.FIXED_MONTHS
                    ? "Every payment, fixed months"
                    : "First payment only"}
              </option>
            ))}
          </select>
        </Field>

        {durationOverride === CommissionDuration.FIXED_MONTHS && (
          <Field label="Duration in months" htmlFor="affiliate-duration-months">
            <Input
              id="affiliate-duration-months"
              name="commissionDurationMonthsOverride"
              type="number"
              min="1"
              max={MAX_COMMISSION_DURATION_MONTHS}
              step="1"
              defaultValue={overrides?.commissionDurationMonthsOverride ?? ""}
              placeholder={
                program.commissionDurationType ===
                CommissionDuration.FIXED_MONTHS
                  ? `Program: ${program.commissionDurationMonths ?? "set months"}`
                  : "For example, 12"
              }
              className="tabular-nums"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Time to buy" htmlFor="affiliate-time-to-buy-override">
            <NumberInput
              id="affiliate-time-to-buy-override"
              name="attributionWindowDaysOverride"
              value={overrides?.attributionWindowDaysOverride ?? null}
              placeholder={String(program.attributionWindowDays)}
              label="Affiliate time to buy in days"
            />
          </Field>
          <Field
            label="Hold before paying"
            htmlFor="affiliate-hold-before-paying-override"
          >
            <NumberInput
              id="affiliate-hold-before-paying-override"
              name="holdingPeriodDaysOverride"
              value={overrides?.holdingPeriodDaysOverride ?? null}
              placeholder={String(program.holdingPeriodDays)}
              label="Affiliate hold before paying in days"
            />
          </Field>
        </div>

        <Field
          label="Minimum payout per currency"
          htmlFor="affiliate-minimum-payout-override"
        >
          <Input
            id="affiliate-minimum-payout-override"
            name="minimumPayoutAmountOverride"
            type="number"
            min="0"
            step="0.01"
            defaultValue={overrides?.minimumPayoutAmountOverride ?? ""}
            placeholder={`Program: ${program.minimumPayoutAmount}`}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            Blank uses the Program minimum. Enter 0 to remove the minimum.
          </p>
        </Field>
      </section>
    </>
  );
}

function ProgramTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function durationOptionLabel(
  type: CommissionDurationType,
  months: number | null,
): string {
  if (type === CommissionDuration.FOREVER) return "Every payment, forever";
  if (type === CommissionDuration.ONE_TIME) return "First payment only";
  return months === null
    ? "Every payment, fixed term"
    : `Every payment for ${months} month${months === 1 ? "" : "s"}`;
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function NumberInput({
  id,
  name,
  value,
  placeholder,
  label,
}: {
  id: string;
  name: string;
  value: number | null;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type="number"
        min="1"
        max={MAX_COMMISSION_TERM_DAYS}
        step="1"
        defaultValue={value ?? ""}
        placeholder={placeholder}
        className="pr-14 tabular-nums"
        aria-label={label}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
        days
      </span>
    </div>
  );
}

const SELECT_FIELD =
  "h-9 w-full min-w-0 rounded-(--radius) border border-input bg-card px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * Supaffi sends no email, so a forgotten password, or an affiliate who signed
 * up before passwords existed, is handled by the Owner: make a one-time link
 * here and send it to them. Making a new one voids the last.
 */
function PasswordLink({
  affiliateId,
  hasPassword,
  product,
  domain,
}: {
  affiliateId: string;
  hasPassword: boolean;
  product: { id: string };
  domain: string;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2">
      {link ? (
        <div className="flex gap-2">
          <Input
            aria-label="One-time affiliate password link"
            readOnly
            value={link}
            className="font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
          <CopyLinkButton link={link} size="sm" label="Copy" />
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await createPasswordLinkAction(
                product,
                affiliateId,
              );
              if ("error" in result) setError(result.error);
              else
                setLink(
                  `${originFor(domain)}/affiliates/password?token=${result.token}`,
                );
            })
          }
        >
          {hasPassword ? "Create password reset link" : "Create password link"}
        </Button>
      )}
      {link && (
        <p className="text-xs text-muted-foreground">
          Works once, for 3 days. Send it to them yourself.
        </p>
      )}
      {error && <p className="text-xs text-status-danger">{error}</p>}
    </div>
  );
}
