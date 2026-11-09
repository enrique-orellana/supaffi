"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Which currency the chart is drawn in.
 *
 * A chart-only override for the account's saved display currency. The saved
 * setting remains the default when the owner returns without a query override.
 */
export function CurrencyPicker({
  value,
  defaultValue,
  options,
  className,
}: {
  value: string;
  /** The preference used when no explicit view override is in the URL. */
  defaultValue: string;
  /** Supported currencies the chart can convert into. */
  options: readonly string[];
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (options.length < 2) return null;

  function choose(next: string | null) {
    if (!next || next === value || !options.includes(next)) return;
    const query = new URLSearchParams(params);
    // The saved preference is the default, so it stays out of the URL.
    if (next === defaultValue) query.delete("currency");
    else query.set("currency", next);
    const search = query.toString();
    startTransition(() =>
      router.push(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      }),
    );
  }

  return (
    <Select
      value={value}
      onValueChange={choose}
      items={Object.fromEntries(
        options.map((code) => [code, code.toUpperCase()]),
      )}
    >
      <SelectTrigger
        size="sm"
        className={cn("cursor-pointer text-[13px]", className)}
        aria-label="Currency"
      >
        {pending && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((code) => (
          <SelectItem key={code} value={code}>
            {code.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
