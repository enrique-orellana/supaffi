"use client";

import { useId, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type LinkOption = { id: string; code: string };

/** Filters for the complete affiliate commission ledger, applied through URL parameters. */
export function AffiliateCommissionFilters({
  links,
  dateFrom,
  dateTo,
  linkId,
  anyFilterActive,
}: {
  links: LinkOption[];
  dateFrom: string;
  dateTo: string;
  linkId: string | null;
  anyFilterActive: boolean;
}) {
  const fieldId = useId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    dateFrom,
    dateTo,
    linkId: linkId ?? "",
  });
  const selectedLink = links.find((link) => link.id === draft.linkId);

  function setDialogOpen(nextOpen: boolean) {
    if (nextOpen) {
      setDraft({ dateFrom, dateTo, linkId: linkId ?? "" });
    }
    setOpen(nextOpen);
  }

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
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="bg-muted hover:bg-muted/80"
            aria-label={
              anyFilterActive ? "Edit commission filters" : "Filter commissions"
            }
            title="Filter commissions"
          />
        }
      >
        <SlidersHorizontal aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Filter commissions</DialogTitle>
          <DialogDescription>
            Choose a date range and referral link for the commission history.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={apply}>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-from`}>From</Label>
              <Input
                id={`${fieldId}-from`}
                type="date"
                value={draft.dateFrom}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dateFrom: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-to`}>To</Label>
              <Input
                id={`${fieldId}-to`}
                type="date"
                value={draft.dateTo}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dateTo: event.target.value,
                  }))
                }
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldId}-link`}>Referral link</Label>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    id={`${fieldId}-link`}
                    type="button"
                    variant="outline"
                    aria-label={`Referral link: ${selectedLink?.code ?? "All links"}`}
                    className="w-full justify-between gap-1.5"
                  />
                }
              >
                <span
                  className={
                    selectedLink ? "font-medium" : "text-muted-foreground"
                  }
                >
                  {selectedLink?.code ?? "All links"}
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
                      onClick={() =>
                        setDraft((current) => ({ ...current, linkId: "" }))
                      }
                      className="w-full"
                    />
                  }
                >
                  <Check
                    className={draft.linkId ? "opacity-0" : "opacity-100"}
                  />
                  <span>All links</span>
                </DropdownMenuItem>
                {links.map((link) => (
                  <DropdownMenuItem
                    key={link.id}
                    className="cursor-pointer"
                    render={
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            linkId: link.id,
                          }))
                        }
                        className="w-full"
                      />
                    }
                  >
                    <Check
                      className={
                        draft.linkId === link.id ? "opacity-100" : "opacity-0"
                      }
                    />
                    <span>{link.code}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DialogFooter className="bg-transparent">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer text-muted-foreground sm:mr-auto"
              onClick={() => setDraft({ dateFrom: "", dateTo: "", linkId: "" })}
            >
              Clear filters
            </Button>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
