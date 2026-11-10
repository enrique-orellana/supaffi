"use client";

import { useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LinkOption = { id: string; code: string };

/**
 * Compact, URL-backed filters for the affiliate commission ledger. The
 * controls follow the same unboxed filter bar used above the owner ledgers.
 */
export function AffiliateCommissionFilters({
  links,
  dateFrom,
  dateTo,
  linkId,
  anyFilterActive,
  invalidDateFilter,
}: {
  links: LinkOption[];
  dateFrom: string;
  dateTo: string;
  linkId: string | null;
  anyFilterActive: boolean;
  invalidDateFilter: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState({
    dateFrom,
    dateTo,
    linkId: linkId ?? "",
  });

  function navigate(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({
      dateFrom: draft.dateFrom,
      dateTo: draft.dateTo,
      link: draft.linkId,
    });
  }

  return (
    <div className="shrink-0">
      <form
        aria-label="Filter commissions"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-5 py-3"
        onSubmit={apply}
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>From</span>
          <Input
            aria-label="From date"
            type="date"
            name="dateFrom"
            value={draft.dateFrom}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dateFrom: event.target.value,
              }))
            }
            className="h-8 w-40 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>To</span>
          <Input
            aria-label="To date"
            type="date"
            name="dateTo"
            value={draft.dateTo}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dateTo: event.target.value,
              }))
            }
            className="h-8 w-40 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Link</span>
          <Select
            name="link"
            items={Object.fromEntries([
              ["all", "All links"],
              ...links.map((link) => [link.id, link.code]),
            ])}
            value={draft.linkId || "all"}
            onValueChange={(next) =>
              setDraft((current) => ({
                ...current,
                linkId: next === "all" ? "" : String(next ?? ""),
              }))
            }
          >
            <SelectTrigger
              aria-label="Referral link"
              className="h-8 min-w-40 cursor-pointer"
            >
              <SelectValue placeholder="All links" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="cursor-pointer">
                All links
              </SelectItem>
              {links.map((link) => (
                <SelectItem
                  key={link.id}
                  value={link.id}
                  className="cursor-pointer"
                >
                  {link.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button type="submit" size="sm" className="h-8 cursor-pointer">
          Apply
        </Button>
        {anyFilterActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 cursor-pointer text-muted-foreground"
            onClick={() => {
              setDraft({ dateFrom: "", dateTo: "", linkId: "" });
              navigate({ dateFrom: null, dateTo: null, link: null });
            }}
          >
            <X />
            Clear
          </Button>
        )}
      </form>
      {invalidDateFilter && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Enter valid dates and make sure the start date is not after the end
          date.
        </p>
      )}
    </div>
  );
}
