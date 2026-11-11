import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const AUDIT_ENTITY_TYPES = {
  PROGRAM: "PROGRAM",
} as const;

export const AUDIT_ACTIONS = {
  UPDATED: "UPDATED",
} as const;

export type AuditEntityType =
  (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

type AuditFieldKind = "string" | "number" | "boolean" | "nullable-number";

const AUDIT_SNAPSHOT_SCHEMAS: Record<
  AuditEntityType,
  Record<string, AuditFieldKind>
> = {
  [AUDIT_ENTITY_TYPES.PROGRAM]: {
    name: "string",
    defaultCommissionRate: "string",
    commissionDurationType: "string",
    commissionDurationMonths: "nullable-number",
    attributionWindowDays: "number",
    holdingPeriodDays: "number",
    currency: "string",
    minimumPayoutAmount: "string",
    signupOpen: "boolean",
  },
};

export type AuditEventRecord = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  createdAt: string;
  actorLabel: string;
  beforeValues: Prisma.JsonValue;
  afterValues: Prisma.JsonValue;
};

export type AuditEventInput = {
  merchantId: string;
  actorOwnerId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  beforeValues: Prisma.InputJsonObject;
  afterValues: Prisma.InputJsonObject;
};

function assertAuditSnapshot(
  entityType: AuditEntityType,
  snapshot: Prisma.InputJsonObject,
): void {
  const schema = AUDIT_SNAPSHOT_SCHEMAS[entityType];
  if (!schema)
    throw new Error(`No audit snapshot schema configured for ${entityType}`);

  const fields = Object.keys(schema);
  const unexpectedFields = Object.keys(snapshot).filter(
    (field) => !(field in schema),
  );
  const missingFields = fields.filter((field) => !(field in snapshot));
  if (unexpectedFields.length > 0) {
    throw new Error(
      `Fields are not allowed in ${entityType} audit snapshots: ${unexpectedFields.join(", ")}`,
    );
  }
  if (missingFields.length > 0) {
    throw new Error(
      `Fields are missing from ${entityType} audit snapshots: ${missingFields.join(", ")}`,
    );
  }

  for (const [field, value] of Object.entries(snapshot)) {
    const kind = schema[field];
    const valid =
      (kind === "string" && typeof value === "string") ||
      (kind === "number" && typeof value === "number") ||
      (kind === "boolean" && typeof value === "boolean") ||
      (kind === "nullable-number" &&
        (typeof value === "number" || value === null));
    if (!valid) {
      throw new Error(`Invalid ${field} value in ${entityType} audit snapshot`);
    }
  }
}

function canonicalJson(value: Prisma.InputJsonObject): string {
  function sortKeys(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(sortKeys);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sortKeys(nested)]),
      );
    }
    return current;
  }

  return JSON.stringify(sortKeys(value));
}

/**
 * Record an explicit, allowlisted before/after snapshot in the caller's
 * transaction. Never pass an unfiltered database row to this function.
 */
export async function recordAuditEvent(
  tx: Prisma.TransactionClient,
  input: AuditEventInput,
): Promise<void> {
  assertAuditSnapshot(input.entityType, input.beforeValues);
  assertAuditSnapshot(input.entityType, input.afterValues);
  if (canonicalJson(input.beforeValues) === canonicalJson(input.afterValues)) {
    return;
  }

  const merchant = await tx.merchant.findUnique({
    where: {
      id_ownerId: {
        id: input.merchantId,
        ownerId: input.actorOwnerId,
      },
    },
    select: { owner: { select: { email: true } } },
  });
  if (!merchant) throw new Error("Audit actor does not own Merchant");

  await tx.auditEvent.create({
    data: {
      merchantId: input.merchantId,
      actorOwnerId: input.actorOwnerId,
      actorLabel: merchant.owner.email,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeValues: input.beforeValues,
      afterValues: input.afterValues,
    },
  });
}

/** Query audit events only inside the authenticated Owner's Merchant. */
export async function listAuditEvents(
  ownerId: string,
  merchantId: string,
  entityType: AuditEntityType,
  entityId: string,
): Promise<AuditEventRecord[]> {
  const events = await db.auditEvent.findMany({
    where: {
      merchantId,
      actorOwnerId: ownerId,
      entityType,
      entityId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      entityType: true,
      entityId: true,
      action: true,
      createdAt: true,
      actorLabel: true,
      beforeValues: true,
      afterValues: true,
    },
  });

  return events.map((event) => ({
    ...event,
    createdAt: event.createdAt.toISOString(),
  }));
}
