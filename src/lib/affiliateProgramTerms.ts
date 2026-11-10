import type { AffiliateProgramTerms, Prisma } from "@prisma/client";

export type AffiliateProgramPair = {
  affiliateId: string;
  programId: string;
};

export type AffiliateProgramTermsReader = Pick<
  Prisma.TransactionClient,
  "affiliateProgramTerms"
>;

export function affiliateProgramTermsKey(
  affiliateId: string,
  programId: string,
): string {
  return `${affiliateId}\u001f${programId}`;
}

/** Batch-load pair-scoped overrides without building one oversized SQL query. */
export async function loadAffiliateProgramTerms(
  client: AffiliateProgramTermsReader,
  merchantId: string,
  pairs: readonly AffiliateProgramPair[],
): Promise<Map<string, AffiliateProgramTerms>> {
  const uniquePairs = new Map(
    pairs.map((pair) => [
      affiliateProgramTermsKey(pair.affiliateId, pair.programId),
      pair,
    ]),
  );
  const values = [...uniquePairs.values()];
  const result = new Map<string, AffiliateProgramTerms>();

  for (let offset = 0; offset < values.length; offset += 500) {
    const batch = values.slice(offset, offset + 500);
    const rows = await client.affiliateProgramTerms.findMany({
      where: {
        merchantId,
        OR: batch,
      },
    });
    for (const row of rows) {
      result.set(affiliateProgramTermsKey(row.affiliateId, row.programId), row);
    }
  }

  return result;
}
