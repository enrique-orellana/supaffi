"use client";

import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TermsForm } from "@/components/TermsForm";
import type { ProgramFormValues } from "@/lib/programValidation";
import type { ProgramActionState } from "@/lib/programValidation";
import type { ProgramEditHistoryEntry } from "@/lib/programHistory";
import { ProgramHistory } from "./ProgramHistory";

/**
 * The terms form, in the panel the list opens. Same form onboarding uses, so a
 * program is written and read in one place and the explanations underneath the
 * fields do not exist twice.
 */

type Action = (
  prev: ProgramActionState,
  formData: FormData,
) => Promise<ProgramActionState>;

export type StoredRateOverride = {
  affiliateId: string;
  affiliateName: string;
  affiliateRate: string | null;
  linkRates: { code: string; rate: string }[];
};

export function ProgramSheet({
  title,
  action,
  initial,
  signupOpen,
  listHref,
  storedRateOverrides = [],
  history = [],
}: {
  title: string;
  action: Action;
  initial?: ProgramFormValues;
  signupOpen: boolean;
  listHref: string;
  storedRateOverrides?: StoredRateOverride[];
  history?: ProgramEditHistoryEntry[];
}) {
  const router = useRouter();

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.push(listHref);
      }}
    >
      <SheetContent className="w-[420px] overflow-y-auto data-[side=right]:sm:max-w-[420px]">
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate">{title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-6">
          {initial ? (
            <Tabs defaultValue="settings" className="w-full">
              <TabsList
                variant="line"
                className="mb-5 w-full border-b border-border"
              >
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <TabsContent value="settings" className="outline-none">
                {storedRateOverrides.length > 0 && (
                  <section className="mb-5 space-y-3 rounded-md border border-status-warning/30 bg-status-warning-bg p-3 text-sm">
                    <div>
                      <h3 className="font-medium text-status-warning">
                        Stored commission rate overrides
                      </h3>
                      <p className="mt-1 text-xs text-status-warning">
                        New referrals use this Program&apos;s rate. Existing
                        Clicks keep their saved rates. Review these stored
                        values before changing the Program rate.
                      </p>
                    </div>
                    <ul className="space-y-2">
                      {storedRateOverrides.map((override) => (
                        <li
                          key={override.affiliateId}
                          className="border-t border-status-warning/20 pt-2 first:border-0 first:pt-0"
                        >
                          <p className="font-medium">
                            {override.affiliateName}
                            {override.affiliateRate !== null && (
                              <span className="font-normal">
                                {` · affiliate ${override.affiliateRate}%`}
                              </span>
                            )}
                          </p>
                          {override.linkRates.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs">
                              {override.linkRates.map((link) => (
                                <li key={link.code} className="break-all">
                                  Link {link.code}: {link.rate}%
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <TermsForm
                  action={action}
                  initial={initial}
                  signupOpen={signupOpen}
                  confirmEdits
                  submitLabel="Save"
                />
              </TabsContent>
              <TabsContent value="history" className="outline-none">
                <ProgramHistory history={history} />
              </TabsContent>
            </Tabs>
          ) : (
            <TermsForm
              action={action}
              signupOpen={signupOpen}
              submitLabel="Create program"
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
