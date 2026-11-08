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
  programName: string;
  /** Without the percent sign. */
  rate: string;
  rateIsOverride: boolean;
  commissionDurationType: CommissionDurationType;
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  payoutDetails: string | null;
  hasPassword: boolean;
  links: {
    id: string;
    url: string;
    clicks: number;
    commissionRateOverride: string | null;
    commissionDurationTypeOverride: CommissionDurationType | null;
    commissionDurationMonthsOverride: number | null;
    attributionWindowDaysOverride: number | null;
    holdingPeriodDaysOverride: number | null;
  }[];
  commissions: {
    id: string;
    date: string;
    amount: string;
    status: CommissionStatus;
  }[];
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
  programs: { id: string; name: string }[];
  product: { id: string; slug: string };
  listHref: string;
}) {
  const router = useRouter();
  const formKey = JSON.stringify({
    programId: affiliate.programId,
    rate: affiliate.rateIsOverride ? affiliate.rate : null,
    links: affiliate.links.map((link) => [
      link.id,
      link.commissionRateOverride,
      link.commissionDurationTypeOverride,
      link.commissionDurationMonthsOverride,
      link.attributionWindowDaysOverride,
      link.holdingPeriodDaysOverride,
    ]),
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
  programs: { id: string; name: string }[];
  product: { id: string; slug: string };
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [durationTypes, setDurationTypes] = useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        affiliate.links.map((link) => [
          link.id,
          link.commissionDurationTypeOverride ?? "inherit",
        ]),
      ),
  );

  function cancelChanges() {
    formRef.current?.reset();
    setDurationTypes(
      Object.fromEntries(
        affiliate.links.map((link) => [
          link.id,
          link.commissionDurationTypeOverride ?? "inherit",
        ]),
      ),
    );
    setError("");
  }

  function saveChanges(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = event.currentTarget;
    const formData = new FormData(form);
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
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={saveChanges}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-5">
        <section className="space-y-4">
          <h3 className="text-sm font-medium">Program and commission</h3>

          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Program</span>
            <select
              name="programId"
              defaultValue={affiliate.programId}
              className={SELECT_FIELD}
            >
              {programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <label htmlFor="affiliate-rate" className="font-medium">
                Commission rate
              </label>
              <span className="text-right text-xs text-muted-foreground">
                Current: {affiliate.rate}% ·{" "}
                {affiliate.rateIsOverride ? "custom" : "program default"}
              </span>
            </div>
            <div className="relative">
              <Input
                id="affiliate-rate"
                name="affiliateRate"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                defaultValue={affiliate.rateIsOverride ? affiliate.rate : ""}
                placeholder="Use program default"
                className="pr-8 tabular-nums"
                aria-label="Affiliate commission rate in percent"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                %
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave empty to use the selected program&apos;s rate.
            </p>
          </div>
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
              Leave a code setting empty to inherit its affiliate setting.
            </p>
          </div>

          {affiliate.links.length === 0 ? (
            <p className="text-sm text-muted-foreground">No links yet.</p>
          ) : (
            <ul className="space-y-5">
              {affiliate.links.map((link) => {
                const durationType = durationTypes[link.id];
                const effectiveDurationType =
                  link.commissionDurationTypeOverride ??
                  affiliate.commissionDurationType;
                const effectiveDurationMonths =
                  link.commissionDurationTypeOverride !== null
                    ? link.commissionDurationMonthsOverride
                    : affiliate.commissionDurationMonths;

                return (
                  <li
                    key={link.id}
                    className="space-y-3 border-t border-border/70 pt-4 first:border-t-0 first:pt-0"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <code className="min-w-0 truncate font-mono text-xs text-foreground">
                        {link.url}
                      </code>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
                        {link.clicks} clicks
                      </span>
                    </div>

                    <input type="hidden" name="linkId" value={link.id} />

                    <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                      <Field
                        label="Commission rate"
                        htmlFor={`${link.id}-rate`}
                      >
                        <div className="relative">
                          <Input
                            id={`${link.id}-rate`}
                            name={`link.${link.id}.commissionRate`}
                            type="number"
                            min="0.01"
                            max="100"
                            step="0.01"
                            defaultValue={link.commissionRateOverride ?? ""}
                            placeholder="Inherit"
                            className="pr-8 tabular-nums"
                            aria-label={`Commission rate for ${link.url}`}
                          />
                          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                            %
                          </span>
                        </div>
                        <CurrentValue>
                          {link.commissionRateOverride === null
                            ? `Inherits ${affiliate.rate}%`
                            : `Code rate: ${link.commissionRateOverride}%`}
                        </CurrentValue>
                      </Field>

                      <Field
                        label="Time to buy"
                        htmlFor={`${link.id}-time-to-buy`}
                      >
                        <NumberInput
                          id={`${link.id}-time-to-buy`}
                          name={`link.${link.id}.timeToBuy`}
                          value={link.attributionWindowDaysOverride}
                          placeholder={String(affiliate.attributionWindowDays)}
                          min="1"
                          step="1"
                          suffix="days"
                          label={`Time to buy for ${link.url}`}
                        />
                        <CurrentValue>
                          {link.attributionWindowDaysOverride === null
                            ? `Inherits ${affiliate.attributionWindowDays} days`
                            : `Code setting: ${link.attributionWindowDaysOverride} days`}
                        </CurrentValue>
                      </Field>

                      <Field
                        label="Hold before paying"
                        htmlFor={`${link.id}-hold-before-paying`}
                      >
                        <NumberInput
                          id={`${link.id}-hold-before-paying`}
                          name={`link.${link.id}.holdBeforePaying`}
                          value={link.holdingPeriodDaysOverride}
                          placeholder={String(affiliate.holdingPeriodDays)}
                          min="1"
                          step="1"
                          suffix="days"
                          label={`Hold before paying for ${link.url}`}
                        />
                        <CurrentValue>
                          {link.holdingPeriodDaysOverride === null
                            ? `Inherits ${affiliate.holdingPeriodDays} days`
                            : `Code setting: ${link.holdingPeriodDaysOverride} days`}
                        </CurrentValue>
                      </Field>

                      <Field
                        label="Commission duration"
                        htmlFor={`${link.id}-duration`}
                        className="col-span-2"
                      >
                        <select
                          id={`${link.id}-duration`}
                          name={`link.${link.id}.durationType`}
                          value={durationType}
                          onChange={(event) =>
                            setDurationTypes((current) => ({
                              ...current,
                              [link.id]: event.target.value,
                            }))
                          }
                          className={SELECT_FIELD}
                        >
                          <option value="inherit">Use affiliate setting</option>
                          {COMMISSION_DURATION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.value === CommissionDuration.FOREVER
                                ? "Every payment · forever"
                                : option.value ===
                                    CommissionDuration.FIXED_MONTHS
                                  ? "Every payment · fixed term"
                                  : "First payment only"}
                            </option>
                          ))}
                        </select>
                        <CurrentValue>
                          {link.commissionDurationTypeOverride === null
                            ? `Inherits ${commissionDurationLabel(effectiveDurationType, effectiveDurationMonths)}`
                            : `Code setting: ${commissionDurationLabel(effectiveDurationType, effectiveDurationMonths)}`}
                        </CurrentValue>
                      </Field>

                      {durationType === CommissionDuration.FIXED_MONTHS && (
                        <Field
                          label="Months"
                          htmlFor={`${link.id}-duration-months`}
                          className="col-span-2"
                        >
                          <Input
                            id={`${link.id}-duration-months`}
                            name={`link.${link.id}.durationMonths`}
                            type="number"
                            min="1"
                            step="1"
                            defaultValue={
                              link.commissionDurationMonthsOverride ??
                              (affiliate.commissionDurationType ===
                              CommissionDuration.FIXED_MONTHS
                                ? (affiliate.commissionDurationMonths ?? 12)
                                : 12)
                            }
                            className="tabular-nums"
                            aria-label={`Commission duration in months for ${link.url}`}
                          />
                        </Field>
                      )}
                    </div>
                  </li>
                );
              })}
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
        {error && (
          <p role="alert" className="mb-3 text-sm text-status-danger">
            {error}
          </p>
        )}
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
  );
}

function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 space-y-1.5 ${className ?? ""}`}>
      <label htmlFor={htmlFor} className="block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function CurrentValue({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] text-muted-foreground">{children}</p>;
}

function NumberInput({
  id,
  name,
  value,
  placeholder,
  min,
  step,
  suffix,
  label,
}: {
  id: string;
  name: string;
  value: number | null;
  placeholder: string;
  min: string;
  step: string;
  suffix: string;
  label: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type="number"
        min={min}
        step={step}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        className="pr-14 tabular-nums"
        aria-label={label}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
        {suffix}
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
