ALTER TABLE "AuditEvent"
    DROP CONSTRAINT "AuditEvent_merchantId_actorOwnerId_fkey";

ALTER TABLE "AuditEvent"
    ADD CONSTRAINT "AuditEvent_merchantId_actorOwnerId_fkey"
    FOREIGN KEY ("merchantId", "actorOwnerId")
    REFERENCES "Merchant"("id", "ownerId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
