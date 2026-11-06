-- Older releases retried every failed provider call. A failed call may have
-- reached NOWPayments before timing out, so preserve those orders for review.
UPDATE "CommerceCheckout"
SET "status" = 'UNCERTAIN',
    "lastCreationError" = 'Provider outcome requires reconciliation',
    "nextAttemptAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('FAILED', 'PENDING');
