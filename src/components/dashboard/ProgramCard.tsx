import Link from "next/link";
import { Pencil, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/CopyLinkButton";

/**
 * One program, owner-facing.
 *
 * The rate and duration stay together. A full-width terms strip gives the
 * attribution window, hold, payout minimum, and dashboard currency enough
 * room to scan without wrapping around icons.
 */
export function ProgramCard({
  name,
  rate,
  dashboardCurrency,
  duration,
  minimumPayoutAmount,
  attributionDays,
  holdingDays,
  affiliateCount,
  signupLink,
  editHref,
}: {
  name: string;
  rate: string;
  dashboardCurrency: string;
  /** "forever", "for 12 months", "on the first payment". */
  duration: string;
  minimumPayoutAmount: string;
  attributionDays: number;
  holdingDays: number;
  affiliateCount: number;
  /** Null when the program's signup is closed. */
  signupLink: string | null;
  editHref: string;
}) {
  return (
    <div className="flex flex-col divide-y divide-neutral-200 rounded-(--radius) border border-neutral-300 bg-card">
      <div className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_max-content] sm:items-center">
        <div className="min-w-0">
          <p className="truncate text-[17px] font-medium tracking-tight">
            {name}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-(--radius) bg-accent-50 px-4 py-3">
          <span className="font-heading text-[32px] leading-none font-medium tracking-tight text-accent-800 tabular-nums">
            {rate}%
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[10px] font-medium tracking-wide text-accent-700 uppercase">
              Commission
            </span>
            <span className="mt-1 truncate text-[13px] font-medium text-accent-700">
              {duration}
            </span>
          </span>
        </div>
        <dl className="col-span-full grid grid-cols-2 divide-x divide-neutral-200 border-t border-neutral-200 pt-4 sm:grid-cols-4">
          <Term value={`${attributionDays} days`} label="Attribution" />
          <Term value={`${holdingDays} days`} label="Hold" />
          <Term
            value={
              Number(minimumPayoutAmount) === 0
                ? "None"
                : minimumPayoutAmount
            }
            label="Minimum"
          />
          <Term value={dashboardCurrency.toUpperCase()} label="Dashboard" />
        </dl>
      </div>
      <div className="flex items-center justify-between gap-4 px-5 py-3">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="size-4" />
          <span className="tabular-nums">
            {affiliateCount === 1
              ? "1 affiliate"
              : `${affiliateCount} affiliates`}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {signupLink ? (
            <CopyLinkButton
              link={signupLink}
              size="sm"
              label="Copy signup link"
            />
          ) : (
            <span className="px-2 text-sm text-muted-foreground">
              Invite only
            </span>
          )}
          <Button variant="ghost" size="sm" render={<Link href={editHref} />}>
            <Pencil />
            Edit
          </Button>
        </div>
      </div>
    </div>
  );
}

function Term({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0 sm:px-4">
      <dt className="text-[11px] leading-tight text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}
