"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Option = { value: string; label: string; hint?: string };

function FilterMenu({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: Option[];
  active: string | null;
  onPick: (value: string | null) => void;
}) {
  const current = options.find((option) => option.value === active);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="cursor-pointer justify-between gap-1.5"
          />
        }
      >
        <span className={current ? "font-medium" : "text-muted-foreground"}>
          {current ? current.label : label}
        </span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-56 overflow-y-auto"
      >
        <DropdownMenuItem
          className="cursor-pointer"
          render={
            <button
              type="button"
              onClick={() => onPick(null)}
              className="w-full"
            />
          }
        >
          <Check className={active === null ? "opacity-100" : "opacity-0"} />
          <span>{label}</span>
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className="cursor-pointer"
            render={
              <button
                type="button"
                onClick={() => onPick(option.value)}
                className="w-full"
              />
            }
          >
            <Check
              className={active === option.value ? "opacity-100" : "opacity-0"}
            />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate">{option.label}</span>
              {option.hint && (
                <span className="truncate text-xs text-muted-foreground">
                  {option.hint}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PayoutFilters({
  affiliates,
  currencies,
  affiliateId,
  currency,
  query,
  anyFilterActive,
}: {
  affiliates: { id: string; name: string | null; email: string }[];
  currencies: string[];
  affiliateId: string | null;
  currency: string | null;
  query: string;
  anyFilterActive: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState(query);

  function push(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    params.delete("page");
    const next = params.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
  }

  function clearFilters() {
    setDraft("");
    push({ affiliate: null, currency: null, q: null });
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-5 py-3">
      <FilterMenu
        label="All affiliates"
        active={affiliateId}
        onPick={(value) => push({ affiliate: value })}
        options={affiliates.map((affiliate) => ({
          value: affiliate.id,
          label: affiliate.name ?? affiliate.email,
          hint: affiliate.name ? affiliate.email : undefined,
        }))}
      />
      {currencies.length > 1 && (
        <FilterMenu
          label="All currencies"
          active={currency}
          onPick={(value) => push({ currency: value })}
          options={currencies.map((code) => ({
            value: code,
            label: code.toUpperCase(),
          }))}
        />
      )}

      <form
        className="relative min-w-52 flex-1 sm:max-w-xs"
        onSubmit={(event) => {
          event.preventDefault();
          push({ q: draft.trim() });
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          type="search"
          aria-label="Search payouts by affiliate"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Affiliate"
          className="h-8 pl-8 text-sm"
        />
      </form>

      {anyFilterActive && (
        <Button
          variant="ghost"
          className="cursor-pointer text-muted-foreground"
          onClick={clearFilters}
        >
          <X />
          Clear
        </Button>
      )}
    </div>
  );
}
