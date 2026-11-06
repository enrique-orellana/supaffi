import { db } from "@/lib/db";
import { slugify } from "@/lib/slugify";

// Readable name-based codes are unique within the Merchant. Current codes,
// imported aliases, and retired codes all reserve the same namespace.
export async function generateLinkCode(name: string, merchantId: string): Promise<string> {
  const base = slugify(name) || "affiliate";
  let candidate = base;
  let suffix = 1;

  while (await isCodeInUse(candidate, merchantId)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

async function isCodeInUse(code: string, merchantId: string): Promise<boolean> {
  const [link, retired] = await Promise.all([
    db.affiliateLink.findFirst({ where: { merchantId, OR: [{ code }, { legacyAliases: { has: code } }] }, select: { id: true } }),
    db.retiredLinkCode.findUnique({ where: { merchantId_code: { merchantId, code } }, select: { id: true } }),
  ]);
  return link !== null || retired !== null;
}
