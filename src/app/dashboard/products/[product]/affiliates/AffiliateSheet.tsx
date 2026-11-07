"use client";

import { useState, useTransition } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { originFor } from "@/lib/url";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import type { CommissionDurationType } from "@prisma/client";
import type { CommissionStatus } from "@/lib/commission";
import {
  COMMISSION_DURATION_OPTIONS,
  CommissionDuration,
  commissionDurationLabel,
  isCommissionDuration,
  type CommissionDurationValue,
} from "@/lib/commissionDuration";
import { changeProgramAction, createPasswordLinkAction, setCustomRateAction, setLinkTermAction } from "./affiliateActions";

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
  commissions: { id: string; date: string; amount: string; status: CommissionStatus }[];
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
  // The trigger shows a program name rather than the cuid the form submits.
  const programNames = Object.fromEntries(programs.map((p) => [p.id, p.name]));

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(listHref);
      }}
    >
      <SheetContent className="w-[420px] overflow-y-auto data-[side=right]:sm:max-w-[420px]">
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate">{affiliate.name ?? affiliate.email}</SheetTitle>
          <SheetDescription className="truncate">
            {affiliate.email} · joined {affiliate.joinedAt}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-4">
          <form
            action={changeProgramAction.bind(null, product, affiliate.id)}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="text-muted-foreground">Program</span>
            <Select name="programId" items={programNames} defaultValue={affiliate.programId}>
              <SelectTrigger className="w-40 cursor-pointer" aria-label="Program">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {programs.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="cursor-pointer">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" variant="secondary" className="cursor-pointer">
              Change
            </Button>
          </form>

          <form
            action={setCustomRateAction.bind(null, product, affiliate.id)}
            className="flex flex-col gap-2 rounded-md border border-border/70 bg-background p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-foreground">Rate</span>
              <span className="flex items-center gap-2 text-right">
                <span className="font-medium tabular-nums">{affiliate.rate}%</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {affiliate.rateIsOverride ? "Custom" : "Program default"}
                </span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                name="rate"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                placeholder="Custom rate (%)"
                className="w-0 flex-1"
                aria-label="Custom rate (%)"
              />
              <Button type="submit" size="sm" variant="secondary" className="cursor-pointer">
                Set
              </Button>
              {affiliate.rateIsOverride && (
                // Its own field, not an empty `rate`: a submit button sharing
                // the input's name loses to whatever was typed in it, so
                // clearing the override says so instead.
                <Button
                  type="submit"
                  size="sm"
                  variant="ghost"
                  className="cursor-pointer"
                  name="intent"
                  value="default"
                >
                  Use default
                </Button>
              )}
            </div>
          </form>

          <div className="flex items-start justify-between gap-3 text-sm">
            <span className="text-muted-foreground">Payout</span>
            <span className="max-w-60 text-right break-words">
              {affiliate.payoutDetails ?? "Not given yet"}
            </span>
          </div>

          <PasswordLink affiliateId={affiliate.id} hasPassword={affiliate.hasPassword} product={product} domain={productDomain} />

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Links</p>
            <ul className="flex flex-col text-sm">
              {affiliate.links.map((l) => (
                <li key={l.id} className="flex flex-col gap-3 border-b border-border/70 py-4 last:border-0">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <code className="min-w-0 truncate font-mono text-xs text-foreground">{l.url}</code>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
                      {l.clicks} clicks
                    </span>
                  </div>
                  <LinkDurationEditor
                    key={`${l.id}-duration-${l.commissionDurationTypeOverride ?? "inherit"}-${l.commissionDurationMonthsOverride ?? ""}`}
                    product={product}
                    affiliateId={affiliate.id}
                    linkId={l.id}
                    valueType={l.commissionDurationTypeOverride}
                    valueMonths={l.commissionDurationMonthsOverride}
                    inheritedType={affiliate.commissionDurationType}
                    inheritedMonths={affiliate.commissionDurationMonths}
                  />
                  <LinkTermEditor
                    key={`${l.id}-rate-${l.commissionRateOverride ?? "inherit"}`}
                    product={product}
                    affiliateId={affiliate.id}
                    linkId={l.id}
                    term="commission"
                    label="Commission (%)"
                    value={l.commissionRateOverride}
                    inheritedValue={affiliate.rate}
                    min="0.01"
                    max="100"
                    step="0.01"
                  />
                  <LinkTermEditor
                    key={`${l.id}-time-to-buy-${l.attributionWindowDaysOverride ?? "inherit"}`}
                    product={product}
                    affiliateId={affiliate.id}
                    linkId={l.id}
                    term="timeToBuy"
                    label="Time to buy (days)"
                    value={l.attributionWindowDaysOverride?.toString() ?? null}
                    inheritedValue={affiliate.attributionWindowDays.toString()}
                    min="1"
                    step="1"
                  />
                  <LinkTermEditor
                    key={`${l.id}-hold-${l.holdingPeriodDaysOverride ?? "inherit"}`}
                    product={product}
                    affiliateId={affiliate.id}
                    linkId={l.id}
                    term="holdBeforePaying"
                    label="Hold before paying (days)"
                    value={l.holdingPeriodDaysOverride?.toString() ?? null}
                    inheritedValue={affiliate.holdingPeriodDays.toString()}
                    min="1"
                    step="1"
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Commissions</p>
            <ul className="flex flex-col gap-1 text-sm">
              {affiliate.commissions.length === 0 && (
                <li className="text-muted-foreground">None yet</li>
              )}
              {affiliate.commissions.map((c) => (
                <li key={c.id} className="flex items-center gap-3">
                  <span className="w-16 text-muted-foreground tabular-nums">{c.date}</span>
                  <span className="flex-1 text-right tabular-nums">{c.amount}</span>
                  <span className="flex w-20 justify-end">
                    <StatusBadge status={c.status} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function LinkTermEditor({
  product,
  affiliateId,
  linkId,
  term,
  label,
  value,
  inheritedValue,
  min,
  max,
  step,
}: {
  product: { id: string; slug: string };
  affiliateId: string;
  linkId: string;
  term: "commission" | "timeToBuy" | "holdBeforePaying";
  label: string;
  value: string | null;
  inheritedValue: string;
  min: string;
  max?: string;
  step: string;
}) {
  const inputId = `${linkId}-${term}`;

  return (
    <form
      action={setLinkTermAction.bind(null, product, affiliateId, linkId, term)}
      className="flex flex-col gap-2 rounded-md border border-border/70 bg-background p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="font-medium text-foreground">{label}</label>
        <span className="text-right text-muted-foreground">
          {value === null ? `Inherits ${inheritedValue}${term === "commission" ? "%" : " days"}` : `This code: ${value}${term === "commission" ? "%" : " days"}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          name="value"
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={value ?? ""}
          placeholder={inheritedValue}
          className="h-8 w-24 bg-background text-right tabular-nums"
          aria-label={label}
        />
        <Button type="submit" size="sm" variant="secondary" className="h-8 cursor-pointer">
          Save
        </Button>
        {value !== null && (
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            className="h-8 cursor-pointer px-2"
            name="intent"
            value="inherit"
          >
            Use inherited
          </Button>
        )}
      </div>
    </form>
  );
}

function LinkDurationEditor({
  product,
  affiliateId,
  linkId,
  valueType,
  valueMonths,
  inheritedType,
  inheritedMonths,
}: {
  product: { id: string; slug: string };
  affiliateId: string;
  linkId: string;
  valueType: CommissionDurationType | null;
  valueMonths: number | null;
  inheritedType: CommissionDurationType;
  inheritedMonths: number | null;
}) {
  const [durationType, setDurationType] = useState<CommissionDurationValue>(valueType ?? inheritedType);
  const [months, setMonths] = useState(() => String(
    valueMonths ?? (inheritedType === CommissionDuration.FIXED_MONTHS ? inheritedMonths : 12)
  ));
  const inputId = `${linkId}-commission-duration`;
  const effectiveType = valueType ?? inheritedType;
  const effectiveMonths = valueType ? valueMonths : inheritedMonths;

  return (
    <form
      action={setLinkTermAction.bind(null, product, affiliateId, linkId, "commissionDuration")}
      className="flex flex-col gap-2 rounded-md border border-border/70 bg-background p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="font-medium text-foreground">Commission duration</label>
        <span className="text-right text-muted-foreground">
          {valueType === null ? "Inherits" : "This code:"} {commissionDurationLabel(effectiveType, effectiveMonths)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          name="durationType"
          value={durationType}
          onValueChange={(next) => {
            if (isCommissionDuration(next)) setDurationType(next);
          }}
          items={Object.fromEntries(COMMISSION_DURATION_OPTIONS.map(({ value, label }) => [value, label]))}
        >
          <SelectTrigger id={inputId} className="h-8 min-w-0 flex-1 cursor-pointer" aria-label="Commission duration">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-72 max-w-[calc(100vw-2rem)]">
            {COMMISSION_DURATION_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value} className="cursor-pointer">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {durationType === CommissionDuration.FIXED_MONTHS && (
          <div className="flex items-center gap-2">
            <Input
              id={`${inputId}-months`}
              name="durationMonths"
              type="number"
              min="1"
              step="1"
              value={months}
              onChange={(event) => setMonths(event.target.value)}
              className="h-8 w-20 bg-background text-right tabular-nums"
              aria-label="Commission months"
            />
            <span className="text-muted-foreground">months</span>
          </div>
        )}
        <Button type="submit" size="sm" variant="secondary" className="h-8 cursor-pointer">
          Save
        </Button>
        {valueType !== null && (
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            className="h-8 cursor-pointer px-2"
            name="intent"
            value="inherit"
            onClick={() => {
              setDurationType(inheritedType);
              setMonths(String(
                inheritedType === CommissionDuration.FIXED_MONTHS ? inheritedMonths ?? 12 : 12
              ));
            }}
          >
            Use program default
          </Button>
        )}
      </div>
    </form>
  );
}

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
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Password</span>
        {hasPassword ? <span>Set</span> : <span className="text-status-warning">Not set yet</span>}
      </div>
      {link ? (
        <div className="flex gap-2">
          <Input readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <CopyLinkButton link={link} size="sm" label="Copy" />
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="cursor-pointer self-start"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await createPasswordLinkAction(product, affiliateId);
              if ("error" in result) setError(result.error);
              else setLink(`${originFor(domain)}/affiliates/password?token=${result.token}`);
            })
          }
        >
          Create password link
        </Button>
      )}
      {link && <p className="text-xs text-muted-foreground">Works once, for 3 days. Send it to them yourself.</p>}
      {error && <p className="text-xs text-status-danger">{error}</p>}
    </div>
  );
}
