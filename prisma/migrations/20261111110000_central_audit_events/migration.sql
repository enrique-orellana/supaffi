CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "actorOwnerId" TEXT NOT NULL,
    "actorLabel" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeValues" JSONB NOT NULL,
    "afterValues" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditEvent_merchantId_actorOwnerId_fkey"
        FOREIGN KEY ("merchantId", "actorOwnerId")
        REFERENCES "Merchant"("id", "ownerId")
        ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "AuditEvent" (
    "id", "merchantId", "actorOwnerId", "actorLabel", "entityType",
    "entityId", "action", "beforeValues", "afterValues", "createdAt"
)
SELECT
    history."id",
    history."merchantId",
    history."actorOwnerId",
    owner."email",
    'PROGRAM',
    history."programId",
    'UPDATED',
    history."beforeValues",
    history."afterValues",
    history."createdAt"
FROM "ProgramEditHistory" AS history
JOIN "Owner" AS owner ON owner."id" = history."actorOwnerId";

DROP TABLE "ProgramEditHistory";

CREATE INDEX "AuditEvent_merchantId_entityType_entityId_createdAt_idx"
    ON "AuditEvent"("merchantId", "entityType", "entityId", "createdAt");

CREATE FUNCTION guard_audit_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Permit referential cleanup when the owning Merchant is deleted. Direct
    -- application-level deletes and all updates remain prohibited.
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Audit events are immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuditEvent_immutable"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION guard_audit_event_immutability();

CREATE FUNCTION reject_audit_event_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuditEvent_no_truncate"
BEFORE TRUNCATE ON "AuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_truncate();
