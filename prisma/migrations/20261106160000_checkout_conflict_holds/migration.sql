ALTER TABLE "Commission"
ADD COLUMN "checkoutConflictHeldAt" TIMESTAMP(3);

ALTER TABLE "CommerceEventDelivery"
ADD COLUMN "checkoutConflictHeldAt" TIMESTAMP(3);

ALTER TABLE "CommerceCheckout"
ADD COLUMN "refundReconciliationPendingAt" TIMESTAMP(3);

CREATE INDEX "Commission_status_conflictHold_idx"
ON "Commission"("status", "checkoutConflictHeldAt");

CREATE INDEX "CommerceEventDelivery_status_conflictHold_nextAttempt_idx"
ON "CommerceEventDelivery"("status", "checkoutConflictHeldAt", "nextAttemptAt");
