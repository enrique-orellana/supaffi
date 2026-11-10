"use client";

import { useId, useState, type FormEvent } from "react";
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

type ProgramOption = { id: string; name: string };
type PayoutFilters = { dateFrom: string; dateTo: string; program: string };

export function PayoutFiltersDialog({
  programOptions,
  filters,
}: {
  programOptions: ProgramOption[];
  filters: PayoutFilters;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const selectedProgramName = programOptions.find(
    (program) => program.id === draft.program,
  )?.name;
  const invalidDateRange = Boolean(
    draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo,
  );

  function setDialogOpen(nextOpen: boolean) {
    if (nextOpen) setDraft(filters);
    setOpen(nextOpen);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    if (invalidDateRange) {
      event.preventDefault();
      return;
    }
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
            aria-label="Filter payment history"
            title="Filter payment history"
          />
        }
      >
        <SlidersHorizontal aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Filter payment history</DialogTitle>
          <DialogDescription>
            Choose which payout records to show.
          </DialogDescription>
        </DialogHeader>

        <form
          method="get"
          action="/affiliates/dashboard/payouts"
          className="grid gap-4"
          onSubmit={apply}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-from`}>From</Label>
              <Input
                id={`${fieldId}-from`}
                type="date"
                name="dateFrom"
                value={draft.dateFrom}
                max={invalidDateRange ? undefined : draft.dateTo || undefined}
                aria-invalid={invalidDateRange || undefined}
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
                name="dateTo"
                value={draft.dateTo}
                min={invalidDateRange ? undefined : draft.dateFrom || undefined}
                aria-invalid={invalidDateRange || undefined}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dateTo: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          {invalidDateRange && (
            <p role="alert" className="text-sm text-status-warning">
              From date must be on or before To date.
            </p>
          )}

          {programOptions.length >= 2 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-program`}>Program</Label>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      id={`${fieldId}-program`}
                      type="button"
                      variant="outline"
                      aria-label={`Program: ${selectedProgramName ?? "All programs"}`}
                      className="w-full justify-between gap-1.5"
                    />
                  }
                >
                  <span
                    className={
                      selectedProgramName
                        ? "font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {selectedProgramName ?? "All programs"}
                  </span>
                  <ChevronDown className="opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuItem
                    className="cursor-pointer"
                    render={
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((current) => ({ ...current, program: "" }))
                        }
                        className="w-full"
                      />
                    }
                  >
                    <Check
                      className={draft.program ? "opacity-0" : "opacity-100"}
                    />
                    <span>All programs</span>
                  </DropdownMenuItem>
                  {programOptions.map((program) => (
                    <DropdownMenuItem
                      key={program.id}
                      className="cursor-pointer"
                      render={
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              program: program.id,
                            }))
                          }
                          className="w-full"
                        />
                      }
                    >
                      <Check
                        className={
                          draft.program === program.id
                            ? "opacity-100"
                            : "opacity-0"
                        }
                      />
                      <span>{program.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          <input type="hidden" name="program" value={draft.program} />

          <DialogFooter className="bg-transparent">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer text-muted-foreground sm:mr-auto"
              onClick={() =>
                setDraft({ dateFrom: "", dateTo: "", program: "" })
              }
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
