import type { AffiliateProgramImportBundle } from "@/lib/imports/canonical";

export type AffiliateImportAdapter = {
  /** Stable public adapter identifier stored on the preview batch. */
  id: string;
  /** Canonical bundle versions this adapter can produce. */
  supportedVersions: readonly number[];
  /** Legacy URL query parameter names this adapter recognizes. */
  legacyQueryParamAliases?: readonly string[];
  /** Convert the source payload to a canonical bundle without persisting it. */
  toCanonicalBundle(input: unknown): unknown | Promise<unknown>;
};

export type ImportedLinkForAliasResolution = {
  merchantId: string;
  code: string;
  legacyAliases?: readonly string[];
  legacyQueryParamAliases?: readonly string[];
};

/**
 * Resolve a legacy query value only against links imported for the requested
 * Merchant. Ambiguous aliases deliberately fail closed.
 */
export function resolveLegacyQueryAlias(input: {
  adapter: AffiliateImportAdapter;
  merchantId: string;
  queryParameter: string;
  queryValue: string;
  importedLinks: readonly ImportedLinkForAliasResolution[];
}): string | null {
  if (!input.adapter.legacyQueryParamAliases?.includes(input.queryParameter))
    return null;
  const parameter = input.queryParameter.toLowerCase();
  const value = input.queryValue.toLowerCase();
  const matches = input.importedLinks.filter(
    (link) =>
      link.merchantId === input.merchantId &&
      link.legacyQueryParamAliases?.includes(parameter) &&
      link.legacyAliases?.some((alias) => alias.toLowerCase() === value),
  );
  return matches.length === 1 ? matches[0].code : null;
}

export function adapterSupportsBundle(
  adapter: AffiliateImportAdapter,
  bundle: AffiliateProgramImportBundle,
): boolean {
  return (
    bundle.manifest.sourceAdapter === adapter.id &&
    adapter.supportedVersions.includes(bundle.manifest.version)
  );
}
