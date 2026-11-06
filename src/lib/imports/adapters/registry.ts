import type { AffiliateImportAdapter } from "@/lib/imports/adapters/types";

/**
 * Import adapters are executable server code. Uploaded bundles only select a
 * registered adapter by ID; they can never provide executable conversion
 * logic.
 */
const adapters: readonly AffiliateImportAdapter[] = [
  {
    id: "canonical-json",
    supportedVersions: [1],
    legacyQueryParamAliases: [],
    toCanonicalBundle(input: unknown): unknown {
      return input;
    },
  },
];

const adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));

export function getAffiliateImportAdapter(id: string): AffiliateImportAdapter | null {
  return adaptersById.get(id) ?? null;
}

export function requireAffiliateImportAdapter(id: string): AffiliateImportAdapter {
  const adapter = getAffiliateImportAdapter(id);
  if (!adapter) throw new Error("This import adapter is not supported by this server.");
  return adapter;
}
