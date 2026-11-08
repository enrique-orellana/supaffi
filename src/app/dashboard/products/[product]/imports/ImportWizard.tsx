"use client";

import { useState } from "react";
import {
  applyAffiliateImportAction,
  previewAffiliateImportAction,
} from "./actions";
import type {
  AffiliateImportApplyChoices,
  AffiliateImportApplyReport,
} from "@/lib/imports/apply";
import type { AffiliateImportPreview } from "@/lib/imports/preview";

type TargetOption = {
  merchantId: string;
  merchantName: string;
  programId: string;
  programName: string;
};
type AffiliateOption = {
  id: string;
  merchantId: string;
  programId: string;
  merchantName: string;
  email: string;
};
type PreviewState = {
  preview: AffiliateImportPreview;
  adapterId: string;
  bundleInfo: {
    productSourceIds: string[];
    affiliates: {
      sourceId: string;
      email?: string;
      productSourceIds: string[];
      activeProductSourceIds: string[];
      hasMerchantScope: boolean;
    }[];
  };
};

function targetKey(target: { merchantId: string; programId: string }): string {
  return `${target.merchantId}::${target.programId}`;
}

export function ImportWizard({
  productSlug,
  targets,
  affiliates,
}: {
  productSlug: string;
  targets: TargetOption[];
  affiliates: AffiliateOption[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [choices, setChoices] = useState<AffiliateImportApplyChoices>({
    productTargets: {},
    affiliateTargets: {},
  });
  const [report, setReport] = useState<AffiliateImportApplyReport | null>(null);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const merchantNames = new Map(
    targets.map((target) => [target.merchantId, target.merchantName]),
  );
  const affiliatesByMerchantEmail = new Map<string, AffiliateOption[]>();
  for (const affiliate of affiliates) {
    const key = `${affiliate.merchantId}:${affiliate.email.trim().toLowerCase()}`;
    const rows = affiliatesByMerchantEmail.get(key) ?? [];
    rows.push(affiliate);
    affiliatesByMerchantEmail.set(key, rows);
  }

  function formForFile(): FormData | null {
    if (!file) return null;
    const data = new FormData();
    data.set("bundle", file);
    return data;
  }

  async function previewBundle() {
    setError(null);
    setReport(null);
    setReviewedKey(null);
    const data = formForFile();
    if (!data) {
      setError("Choose the bundle file first.");
      return;
    }
    setBusy(true);
    const result = await previewAffiliateImportAction(productSlug, data);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      setPreview(null);
      return;
    }
    setPreview(result);
    setChoices({ productTargets: {}, affiliateTargets: {} });
  }

  async function reviewMappings() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const data = formForFile()!;
    const mappingChoices = JSON.stringify(choices);
    data.set("mappingChoices", mappingChoices);
    const result = await previewAffiliateImportAction(productSlug, data);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      setReviewedKey(null);
      return;
    }
    setPreview(result);
    setReviewedKey(mappingChoices);
  }

  function updateProductTarget(sourceProductId: string, selected: string) {
    const productTargets = { ...(choices.productTargets ?? {}) };
    if (!selected) delete productTargets[sourceProductId];
    else {
      const [merchantId, programId] = selected.split("::");
      if (merchantId && programId)
        productTargets[sourceProductId] = { merchantId, programId };
    }
    setChoices({ ...choices, productTargets });
  }

  function updateAffiliateTarget(
    sourceAffiliateId: string,
    merchantId: string,
    affiliateId: string,
  ) {
    const affiliateTargets = { ...(choices.affiliateTargets ?? {}) };
    const byMerchant = { ...(affiliateTargets[sourceAffiliateId] ?? {}) };
    if (!affiliateId) delete byMerchant[merchantId];
    else byMerchant[merchantId] = affiliateId;
    if (Object.keys(byMerchant).length)
      affiliateTargets[sourceAffiliateId] = byMerchant;
    else delete affiliateTargets[sourceAffiliateId];
    setChoices({ ...choices, affiliateTargets });
  }

  const affiliateTargetRows = preview
    ? preview.bundleInfo.affiliates.flatMap((source) => {
        const targetPairs = [
          ...source.activeProductSourceIds.flatMap((sourceProductId) =>
            choices.productTargets?.[sourceProductId]
              ? [choices.productTargets[sourceProductId]]
              : [],
          ),
          ...(source.hasMerchantScope && choices.defaultTarget
            ? [choices.defaultTarget]
            : []),
        ];
        const byMerchant = new Map<string, Set<string>>();
        for (const target of targetPairs) {
          const programIds =
            byMerchant.get(target.merchantId) ?? new Set<string>();
          programIds.add(target.programId);
          byMerchant.set(target.merchantId, programIds);
        }
        return [...byMerchant.entries()].map(([merchantId, programIds]) => ({
          source,
          target: { merchantId, programId: [...programIds][0] },
          programConflict: programIds.size > 1,
        }));
      })
    : [];

  async function confirmImport() {
    if (!file || !preview || reviewedKey !== JSON.stringify(choices)) {
      setError("Review the current target selections before confirming.");
      return;
    }
    setError(null);
    setBusy(true);
    const data = formForFile()!;
    data.set("batchId", preview.preview.batchId);
    data.set("adapterId", preview.adapterId);
    data.set("mappingChoices", JSON.stringify(choices));
    const result = await applyAffiliateImportAction(productSlug, data);
    if ("error" in result) setError(result.error ?? "Import failed.");
    else setReport(result.report);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-(--radius) border border-border bg-elevated p-5">
        <h2 className="text-sm font-medium">Choose an import bundle</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a versioned JSON file up to 8 MiB. The bundle is processed for
          the preview and must be uploaded again to confirm; it is not stored.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="application/json,.json"
            disabled={report?.status === "APPLYING"}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setReport(null);
              setReviewedKey(null);
              setChoices({ productTargets: {}, affiliateTargets: {} });
            }}
          />
          <button
            type="button"
            disabled={!file || busy}
            onClick={previewBundle}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Working…" : "Preview bundle"}
          </button>
        </div>
        {file && (
          <p className="mt-2 text-xs text-muted-foreground">
            {file.name} · {(file.size / 1024).toFixed(0)} KiB
          </p>
        )}
      </section>

      {preview && (
        <>
          <section className="rounded-(--radius) border border-border bg-elevated p-5">
            <h2 className="text-sm font-medium">Dry-run summary</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Batch {preview.preview.batchId} · digest {preview.preview.digest}
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(preview.preview.counts).map(([name, count]) => (
                <div key={name} className="rounded-md bg-background p-3">
                  <div className="text-xs capitalize text-muted-foreground">
                    {name}
                  </div>
                  <div className="text-lg font-medium">{count}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-5 md:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold">Commission totals</h3>
                {preview.preview.commissionsByCurrency.map((row) => (
                  <p key={row.currency} className="mt-1 text-sm">
                    {row.currency}: {row.grossMinor} gross, {row.refundedMinor}{" "}
                    refunded, {row.netMinor} net (minor units)
                  </p>
                ))}
              </div>
              <div>
                <h3 className="text-xs font-semibold">Payout snapshots</h3>
                {preview.preview.payoutsByCurrency.map((row) => (
                  <p key={row.currency} className="mt-1 text-sm">
                    {row.currency}: {row.totalMinor} minor units
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-(--radius) border border-border bg-elevated p-5">
            <h2 className="text-sm font-medium">
              Choose where imported links belong
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each source product maps to one Merchant and Program owned by this
              account. Existing affiliates are linked only after an explicit
              choice.
            </p>
            {preview.bundleInfo.productSourceIds.length > 0 && (
              <div className="mt-4 flex flex-col gap-3">
                {preview.bundleInfo.productSourceIds.map((sourceId) => (
                  <label
                    key={sourceId}
                    className="grid gap-1 text-sm sm:grid-cols-[1fr_2fr] sm:items-center"
                  >
                    <span>
                      Source product <code>{sourceId}</code>
                    </span>
                    <select
                      disabled={report?.status === "APPLYING"}
                      className="rounded-md border border-border bg-background px-3 py-2 disabled:opacity-50"
                      value={
                        choices.productTargets?.[sourceId]
                          ? targetKey(choices.productTargets[sourceId]!)
                          : ""
                      }
                      onChange={(event) =>
                        updateProductTarget(sourceId, event.target.value)
                      }
                    >
                      <option value="">Leave unallocated</option>
                      {targets.map((target) => (
                        <option
                          key={targetKey(target)}
                          value={targetKey(target)}
                        >
                          {target.merchantName} · {target.programName}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <label className="mt-4 grid gap-1 text-sm sm:grid-cols-[1fr_2fr] sm:items-center">
              <span>Merchant-wide links</span>
              <select
                disabled={report?.status === "APPLYING"}
                className="rounded-md border border-border bg-background px-3 py-2 disabled:opacity-50"
                value={
                  choices.defaultTarget ? targetKey(choices.defaultTarget) : ""
                }
                onChange={(event) => {
                  const [merchantId, programId] =
                    event.target.value.split("::");
                  setChoices({
                    ...choices,
                    defaultTarget:
                      merchantId && programId
                        ? { merchantId, programId }
                        : undefined,
                  });
                }}
              >
                <option value="">Leave unallocated</option>
                {targets.map((target) => (
                  <option key={targetKey(target)} value={targetKey(target)}>
                    {target.merchantName} · {target.programName}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-5 flex flex-col gap-3">
              {affiliateTargetRows.map(
                ({ source, target, programConflict }) => (
                  <label
                    key={`${source.sourceId}:${target.merchantId}`}
                    className="grid gap-1 text-sm sm:grid-cols-[1fr_2fr] sm:items-center"
                  >
                    <span>
                      <code>{source.sourceId}</code> in{" "}
                      {merchantNames.get(target.merchantId)}
                      {programConflict ? " · multiple Program mappings" : ""}
                    </span>
                    <select
                      disabled={
                        programConflict || report?.status === "APPLYING"
                      }
                      className="rounded-md border border-border bg-background px-3 py-2 disabled:opacity-50"
                      value={
                        choices.affiliateTargets?.[source.sourceId]?.[
                          target.merchantId
                        ] ?? ""
                      }
                      onChange={(event) =>
                        updateAffiliateTarget(
                          source.sourceId,
                          target.merchantId,
                          event.target.value,
                        )
                      }
                    >
                      <option value="">
                        Create a separate affiliate when possible
                      </option>
                      {(source.email
                        ? (affiliatesByMerchantEmail.get(
                            `${target.merchantId}:${source.email.trim().toLowerCase()}`,
                          ) ?? [])
                        : []
                      )
                        .filter(
                          (affiliate) =>
                            affiliate.programId === target.programId,
                        )
                        .map((affiliate) => (
                          <option key={affiliate.id} value={affiliate.id}>
                            {affiliate.email}
                          </option>
                        ))}
                    </select>
                  </label>
                ),
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Email matches are never merged automatically. New imported
              affiliates have no password or payout details.
            </p>
            <button
              type="button"
              disabled={busy || !file || report?.status === "APPLYING"}
              onClick={reviewMappings}
              className="mt-5 rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              Review mappings and conflicts
            </button>
            {reviewedKey === JSON.stringify(choices) && (
              <div className="mt-4 rounded-md border border-border p-4">
                <h3 className="text-sm font-medium">Mapping review</h3>
                {preview.preview.productScopes.unmappable.length > 0 && (
                  <p className="mt-2 text-sm">
                    {preview.preview.productScopes.unmappable.length} product
                    scopes will remain unallocated or cannot be applied.
                  </p>
                )}
                {preview.preview.productScopes.unreliableTargets.length > 0 && (
                  <p className="mt-1 text-sm">
                    {preview.preview.productScopes.unreliableTargets.length}{" "}
                    target Merchants have unverified tracking.
                  </p>
                )}
                {preview.preview.productScopes.unmappable
                  .slice(0, 20)
                  .map((scope) => (
                    <p
                      key={scope.productSourceId}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      Product {scope.productSourceId}: {scope.reason}
                    </p>
                  ))}
                {preview.preview.productScopes.unreliableTargets
                  .slice(0, 20)
                  .map((scope) => (
                    <p
                      key={`${scope.scopeLabel}:${scope.targetProductId}`}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {scope.scopeLabel}: target {scope.targetProductId} has
                      unverified tracking.
                    </p>
                  ))}
                {preview.preview.conflicts.rate.length +
                  preview.preview.conflicts.identity.length +
                  preview.preview.conflicts.code.length ===
                0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No rate, identity, or code conflicts were found.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col gap-1 text-sm">
                    {[
                      ...preview.preview.conflicts.rate.map((item) => ({
                        ...item,
                        kind: "Rate",
                      })),
                      ...preview.preview.conflicts.identity.map((item) => ({
                        ...item,
                        kind: "Identity",
                      })),
                      ...preview.preview.conflicts.code.map((item) => ({
                        ...item,
                        kind: "Code",
                      })),
                    ]
                      .slice(0, 40)
                      .map((item, index) => (
                        <p key={`${item.kind}-${item.sourceId}-${index}`}>
                          {item.kind} · {item.sourceId}: {item.reason}
                        </p>
                      ))}
                    {preview.preview.conflicts.rate.length +
                      preview.preview.conflicts.identity.length +
                      preview.preview.conflicts.code.length >
                      40 && (
                      <p className="text-muted-foreground">
                        Showing the first 40 conflicts.
                      </p>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy || !file || report?.status === "COMPLETED"}
                  onClick={confirmImport}
                  className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  {busy
                    ? "Applying…"
                    : report?.status === "APPLYING"
                      ? "Resume import"
                      : report?.status === "COMPLETED"
                        ? "Import completed"
                        : "Confirm import"}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      {report && (
        <section className="rounded-(--radius) border border-border bg-elevated p-5">
          <h2 className="text-sm font-medium">
            Import progress: {report.status}
          </h2>
          <p className="mt-2 text-sm">
            Affiliates {report.processed.affiliates} · links{" "}
            {report.processed.links} · commission rows{" "}
            {report.processed.commissions} · payout snapshots{" "}
            {report.processed.payouts}
          </p>
          <p className="mt-1 text-sm">
            Merged {report.merged} · skipped {report.skipped} · conflicts{" "}
            {report.conflicts} · unallocated {report.unallocated}
          </p>
          {report.totalsByCurrency.map((row) => (
            <p key={row.currency} className="mt-1 text-sm">
              {row.currency}: commissions {row.commissionMinor}, payouts{" "}
              {row.payoutMinor} minor units
            </p>
          ))}
        </section>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
