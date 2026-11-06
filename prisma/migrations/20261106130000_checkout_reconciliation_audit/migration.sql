ALTER TABLE "CommerceCheckout"
ADD COLUMN "reconciliationResolution" TEXT,
ADD COLUMN "reconciledAt" TIMESTAMP(3),
ADD COLUMN "reconciledByOwnerId" TEXT;

ALTER TABLE "CommerceCheckout"
ADD CONSTRAINT "CommerceCheckout_reconciledByOwnerId_fkey"
FOREIGN KEY ("reconciledByOwnerId") REFERENCES "Owner"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CommerceCheckout_reconciliationResolution_reconciledAt_idx"
ON "CommerceCheckout"("reconciliationResolution", "reconciledAt");
