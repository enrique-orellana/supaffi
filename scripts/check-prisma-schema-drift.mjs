import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to check the migrated schema.");
  process.exit(1);
}

const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    "migrate",
    "diff",
    "--from-url",
    databaseUrl,
    "--to-schema-datamodel",
    resolve(root, "prisma/schema.prisma"),
    "--script",
  ],
  { cwd: root, encoding: "utf8" },
);

if (result.error || result.status !== 0) {
  const details = `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(
    databaseUrl,
    "[DATABASE_URL]",
  );
  console.error(details || "Prisma schema diff failed.");
  process.exit(1);
}

// These tenant-scoped constraints are deliberately migration-owned. Prisma
// cannot model them without making trigger-populated Commission.merchantId
// required in generated write inputs. PostgreSQL also truncates one historical
// index name at its identifier-length limit. Require these known differences
// while failing on every other database/schema difference.
const expectedKnownDifferences = new Set([
  'ALTER TABLE "Commission" DROP CONSTRAINT "Commission_affiliateId_merchantId_fkey"',
  'ALTER TABLE "Commission" DROP CONSTRAINT "Commission_clickId_merchantId_fkey"',
  'ALTER TABLE "Commission" DROP CONSTRAINT "Commission_merchantId_paymentRecordId_fkey"',
  'ALTER INDEX "AffiliateImportBatch_merchantId_sourceAdapter_normalizedDigest_" RENAME TO "AffiliateImportBatch_merchantId_sourceAdapter_normalizedDig_key"',
]);

const actualStatements = result.stdout
  .replace(/^--[^\r\n]*$/gm, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
const actualSet = new Set(actualStatements);
const unexpected = actualStatements.filter(
  (statement) => !expectedKnownDifferences.has(statement),
);
const missing = [...expectedKnownDifferences].filter(
  (statement) => !actualSet.has(statement),
);

if (unexpected.length || missing.length) {
  console.error("Prisma schema drift check failed.");
  if (unexpected.length) {
    console.error("Unexpected schema differences:");
    for (const statement of unexpected) console.error(`- ${statement};`);
  }
  if (missing.length) {
    console.error(
      "Expected schema safeguards or historical index state are missing:",
    );
    for (const statement of missing) console.error(`- ${statement};`);
  }
  process.exit(1);
}

console.log(
  "Database matches the Prisma schema with the three migration-owned tenant constraints and historical truncated index name.",
);
