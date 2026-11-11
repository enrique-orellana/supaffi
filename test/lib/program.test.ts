// Destructive: runs db.affiliateLink.deleteMany() / db.affiliate.deleteMany() /
// db.program.deleteMany() / db.merchant.deleteMany() / db.owner.deleteMany()
// before every test. Point DATABASE_URL at a disposable database, never a
// real deployment's data.
import { PaymentProvider } from "@/lib/payments/types";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  listAuditEvents,
  recordAuditEvent,
} from "@/lib/audit";
import {
  createProgram,
  listProgramsForMerchant,
  getProgramForMerchant,
  updateProgram,
  getProgramForSignup,
  getClosedProgramName,
  getDefaultProgramSlug,
} from "@/lib/program";

// Skip this whole suite cleanly when no database is reachable, instead of
// letting Prisma throw an opaque connection error mid-run. Checked once, up
// front, via a real connection attempt (not just "is DATABASE_URL set") so a
// stale/unreachable URL also skips rather than failing the suite.
let hasDatabase = false;
if (process.env.DATABASE_URL) {
  try {
    await db.$connect();
    hasDatabase = true;
  } catch {
    hasDatabase = false;
  }
}

if (!hasDatabase) {
  // eslint-disable-next-line no-console
  console.warn(
    "Skipping test/lib/program.test.ts: no reachable DATABASE_URL. Set DATABASE_URL to a disposable database to run these tests.",
  );
}

const baseInput = {
  name: "Standard",
  defaultCommissionRate: 20,
  commissionDurationType: "FOREVER" as const,
  commissionDurationMonths: null,
  attributionWindowDays: 60,
  holdingPeriodDays: 30,
};

describe.skipIf(!hasDatabase)("program", () => {
  let ownerId: string;
  let merchantId: string;
  let merchantId2: string;
  let otherOwnerId: string;
  let otherMerchantId: string;

  beforeEach(async () => {
    // Affiliates reference Program with a RESTRICT foreign key, so they have
    // to go first (and AffiliateLink before Affiliate, same reason) or
    // Program.deleteMany throws instead of cleaning up.
    await db.affiliateLink.deleteMany();
    await db.affiliate.deleteMany();
    await db.program.deleteMany();
    await db.paymentConnection.deleteMany();
    await db.merchant.deleteMany();
    await db.owner.deleteMany();

    const owner = await db.owner.create({
      data: { email: "program-test-owner@example.com", passwordHash: "x" },
    });
    ownerId = owner.id;
    const merchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId,
        name: "M",
        domain: "program-test.example.com",
        websiteUrl: "https://example.com",
        paymentConnections: {
          create: {
            provider: PaymentProvider.STRIPE.database,
            apiKeyEnc: "x",
            webhookSecretEnc: "x",
            status: "CONNECTED",
            enabled: true,
          },
        },
      },
    });
    merchantId = merchant.id;

    // A second Merchant owned by the SAME Owner — the boundary that
    // getProgramForMerchant/updateProgram's `where: { id, merchantId }`
    // filter (scoped in addition to the ownership check) protects against.
    const merchant2 = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId,
        name: "M2",
        domain: "program-test-2.example.com",
        websiteUrl: "https://example.com",
        paymentConnections: {
          create: {
            provider: PaymentProvider.STRIPE.database,
            apiKeyEnc: "x",
            webhookSecretEnc: "x",
            status: "CONNECTED",
            enabled: true,
          },
        },
      },
    });
    merchantId2 = merchant2.id;

    const otherOwner = await db.owner.create({
      data: {
        email: "program-test-other-owner@example.com",
        passwordHash: "x",
      },
    });
    otherOwnerId = otherOwner.id;
    const otherMerchant = await db.merchant.create({
      data: {
        slug: crypto.randomUUID(),
        ownerId: otherOwnerId,
        name: "OM",
        domain: "program-test-other.example.com",
        websiteUrl: "https://example.com",
        paymentConnections: {
          create: {
            provider: PaymentProvider.STRIPE.database,
            apiKeyEnc: "x",
            webhookSecretEnc: "x",
            status: "CONNECTED",
            enabled: true,
          },
        },
      },
    });
    otherMerchantId = otherMerchant.id;
  });

  afterAll(async () => {
    await db.affiliateLink.deleteMany();
    await db.affiliate.deleteMany();
    await db.program.deleteMany();
    await db.paymentConnection.deleteMany();
    await db.merchant.deleteMany();
    await db.owner.deleteMany();
    await db.$disconnect();
  });

  it("creates a Program under a Merchant the Owner owns", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    const raw = await db.program.findUniqueOrThrow({ where: { id } });
    expect(raw.name).toBe("Standard");
    expect(Number(raw.defaultCommissionRate)).toBe(20);
  });

  it("refuses to create a Program under a Merchant the Owner doesn't own", async () => {
    await expect(
      createProgram(ownerId, otherMerchantId, baseInput),
    ).rejects.toThrow();
  });

  it("lists only Programs for the given, owned Merchant", async () => {
    await createProgram(ownerId, merchantId, baseInput);
    const list = await listProgramsForMerchant(ownerId, merchantId);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Standard");
  });

  it("lists Programs with the terms the Programs screen's cards need", async () => {
    await createProgram(ownerId, merchantId, {
      ...baseInput,
      commissionDurationType: "FIXED_MONTHS",
      commissionDurationMonths: 12,
      attributionWindowDays: 45,
      holdingPeriodDays: 15,
    });

    const [program] = await listProgramsForMerchant(ownerId, merchantId);
    expect(program.commissionDurationType).toBe("FIXED_MONTHS");
    expect(program.commissionDurationMonths).toBe(12);
    expect(program.attributionWindowDays).toBe(45);
    expect(program.holdingPeriodDays).toBe(15);
  });

  it("lists Programs with their affiliate count", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await db.affiliate.create({
      data: {
        merchantId,
        programId: id,
        email: "sarah@example.com",
        links: { create: { code: "sarah", isPrimary: true } },
      },
    });
    await db.affiliate.create({
      data: {
        merchantId,
        programId: id,
        email: "rob@example.com",
        links: { create: { code: "rob", isPrimary: true } },
      },
    });

    const list = await listProgramsForMerchant(ownerId, merchantId);
    expect(list[0].affiliateCount).toBe(2);
  });

  it("getProgramForMerchant returns null when the Merchant isn't owned by the caller", async () => {
    const { slug } = await db.program.create({
      data: {
        merchantId: otherMerchantId,
        slug: crypto.randomUUID(),
        ...baseInput,
        defaultCommissionRate: 20,
      },
    });
    const result = await getProgramForMerchant(ownerId, otherMerchantId, slug);
    expect(result).toBeNull();
  });

  it("getProgramForMerchant returns null for a Program under a different Merchant owned by the SAME Owner", async () => {
    const { slug } = await createProgram(ownerId, merchantId, baseInput);
    const result = await getProgramForMerchant(ownerId, merchantId2, slug);
    expect(result).toBeNull();
  });

  it("updateProgram updates fields and validates FIXED_MONTHS requires commissionDurationMonths", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      name: "Renamed",
      commissionDurationType: "FIXED_MONTHS",
      commissionDurationMonths: 12,
    });
    const raw = await db.program.findUniqueOrThrow({ where: { id } });
    expect(raw.name).toBe("Renamed");
    expect(raw.commissionDurationType).toBe("FIXED_MONTHS");
    expect(raw.commissionDurationMonths).toBe(12);
  });

  it("records changed Program settings in the audit module with before and after values and the editing Owner", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      name: "Arthouse Partners",
      defaultCommissionRate: 16,
    });

    const history = await listAuditEvents(
      ownerId,
      merchantId,
      AUDIT_ENTITY_TYPES.PROGRAM,
      id,
    );

    expect(history).toHaveLength(1);
    expect(history[0].action).toBe(AUDIT_ACTIONS.UPDATED);
    expect(history[0].actorLabel).toBe("program-test-owner@example.com");
    expect(history[0].beforeValues).toMatchObject({
      name: "Standard",
      defaultCommissionRate: "20.00",
    });
    expect(history[0].afterValues).toMatchObject({
      name: "Arthouse Partners",
      defaultCommissionRate: "16.00",
    });
  });

  it("does not create a history entry when saving unchanged Program settings", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, baseInput);

    expect(
      await db.auditEvent.count({
        where: {
          merchantId,
          entityType: AUDIT_ENTITY_TYPES.PROGRAM,
          entityId: id,
        },
      }),
    ).toBe(0);
  });

  it("rolls back an audit event when the surrounding Program transaction fails", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);

    await expect(
      db.$transaction(async (tx) => {
        await tx.program.update({
          where: { id },
          data: { defaultCommissionRate: 16 },
        });
        await recordAuditEvent(tx, {
          merchantId,
          actorOwnerId: ownerId,
          entityType: AUDIT_ENTITY_TYPES.PROGRAM,
          entityId: id,
          action: AUDIT_ACTIONS.UPDATED,
          beforeValues: {
            name: "Standard",
            defaultCommissionRate: "20.00",
            commissionDurationType: "FOREVER",
            commissionDurationMonths: null,
            attributionWindowDays: 60,
            holdingPeriodDays: 30,
            currency: "eur",
            minimumPayoutAmount: "0.00",
            signupOpen: true,
          },
          afterValues: {
            name: "Standard",
            defaultCommissionRate: "16.00",
            commissionDurationType: "FOREVER",
            commissionDurationMonths: null,
            attributionWindowDays: 60,
            holdingPeriodDays: 30,
            currency: "eur",
            minimumPayoutAmount: "0.00",
            signupOpen: true,
          },
        });
        throw new Error("abort Program update");
      }),
    ).rejects.toThrow("abort Program update");

    const program = await db.program.findUniqueOrThrow({ where: { id } });
    expect(program.defaultCommissionRate.toFixed(2)).toBe("20.00");
    expect(
      await db.auditEvent.count({
        where: {
          merchantId,
          entityType: AUDIT_ENTITY_TYPES.PROGRAM,
          entityId: id,
        },
      }),
    ).toBe(0);
  });

  it("rejects audit snapshots containing fields outside the entity allowlist", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);

    await expect(
      db.$transaction((tx) =>
        recordAuditEvent(tx, {
          merchantId,
          actorOwnerId: ownerId,
          entityType: AUDIT_ENTITY_TYPES.PROGRAM,
          entityId: id,
          action: AUDIT_ACTIONS.UPDATED,
          beforeValues: { name: "Standard", passwordHash: "private" },
          afterValues: { name: "Changed", passwordHash: "private" },
        }),
      ),
    ).rejects.toThrow(/not allowed in Program audit snapshots/i);
  });

  it("scopes audited Program changes to the Owner and Merchant", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      defaultCommissionRate: 16,
    });

    expect(
      await listAuditEvents(
        ownerId,
        merchantId2,
        AUDIT_ENTITY_TYPES.PROGRAM,
        id,
      ),
    ).toEqual([]);
    expect(
      await listAuditEvents(
        otherOwnerId,
        merchantId,
        AUDIT_ENTITY_TYPES.PROGRAM,
        id,
      ),
    ).toEqual([]);
  });

  it("rejects attempts to update or delete persisted audit events", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      defaultCommissionRate: 16,
    });
    const [event] = await db.auditEvent.findMany({
      where: {
        merchantId,
        entityType: AUDIT_ENTITY_TYPES.PROGRAM,
        entityId: id,
      },
      select: { id: true },
    });

    await expect(
      db.auditEvent.update({
        where: { id: event.id },
        data: { action: "REPLACED" },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      db.auditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/immutable/i);
    await expect(db.$executeRaw`TRUNCATE TABLE "AuditEvent"`).rejects.toThrow(
      /immutable/i,
    );
  });

  it("prevents a Merchant owner change from rewriting historical audit actors", async () => {
    const { id } = await createProgram(ownerId, merchantId, baseInput);
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      defaultCommissionRate: 16,
    });

    await expect(
      db.merchant.update({
        where: { id: merchantId },
        data: { ownerId: otherOwnerId },
      }),
    ).rejects.toThrow();

    const [event] = await db.auditEvent.findMany({
      where: {
        merchantId,
        entityType: AUDIT_ENTITY_TYPES.PROGRAM,
        entityId: id,
      },
      select: { actorOwnerId: true },
    });
    expect(event.actorOwnerId).toBe(ownerId);
  });

  it("updateProgram throws when the Merchant isn't owned by the caller", async () => {
    const { id } = await db.program.create({
      data: {
        merchantId: otherMerchantId,
        slug: crypto.randomUUID(),
        ...baseInput,
      },
    });
    await expect(
      updateProgram(ownerId, otherMerchantId, id, {
        ...baseInput,
        name: "Hijacked",
      }),
    ).rejects.toThrow();
  });

  it("getProgramForSignup resolves a Program scoped to its Merchant, no owner required", async () => {
    const { slug } = await createProgram(ownerId, merchantId, baseInput);

    const result = await getProgramForSignup(merchantId, slug);
    expect(result?.name).toBe("Standard");
  });

  it("getProgramForSignup returns null for a Program whose signup is closed, and an update without the flag keeps it closed", async () => {
    const { id, slug } = await createProgram(ownerId, merchantId, {
      ...baseInput,
      signupOpen: false,
    });
    expect(await getProgramForSignup(merchantId, slug)).toBeNull();

    // Onboarding saves the terms without the flag.
    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      name: "Standard",
    });
    expect(await getProgramForSignup(merchantId, slug)).toBeNull();

    await updateProgram(ownerId, merchantId, id, {
      ...baseInput,
      signupOpen: true,
    });
    expect((await getProgramForSignup(merchantId, slug))?.name).toBe(
      "Standard",
    );
  });

  it("getClosedProgramName names a closed Program on its own Merchant only", async () => {
    const closed = await createProgram(ownerId, merchantId, {
      ...baseInput,
      name: "Creators",
      signupOpen: false,
    });
    const open = await createProgram(ownerId, merchantId, baseInput);

    expect(await getClosedProgramName(merchantId, closed.slug)).toBe(
      "Creators",
    );
    expect(await getClosedProgramName(merchantId, open.slug)).toBeNull();
    expect(await getClosedProgramName(merchantId2, closed.slug)).toBeNull();
    expect(await getClosedProgramName(merchantId, "missing")).toBeNull();
  });

  it("getDefaultProgramSlug is this Merchant's oldest open Program", async () => {
    expect(await getDefaultProgramSlug(merchantId)).toBeNull();

    const closed = await createProgram(ownerId, merchantId, {
      ...baseInput,
      name: "Creators",
      signupOpen: false,
    });
    const first = await createProgram(ownerId, merchantId, {
      ...baseInput,
      name: "Partners",
    });
    await createProgram(ownerId, merchantId, {
      ...baseInput,
      name: "Agencies",
    });
    await createProgram(ownerId, merchantId2, {
      ...baseInput,
      name: "Elsewhere",
    });

    expect(await getDefaultProgramSlug(merchantId)).toBe(first.slug);
    expect(closed.slug).not.toBe(first.slug);
  });

  it("getProgramForSignup returns null when the Program belongs to a different Merchant", async () => {
    const { slug } = await createProgram(ownerId, merchantId, baseInput);

    const result = await getProgramForSignup(merchantId2, slug);
    expect(result).toBeNull();
  });
});
