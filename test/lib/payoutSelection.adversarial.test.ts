// Destructive: these integration tests clear tables in the dedicated
// supaffi_test database configured by test/setup.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PaymentProvider } from "@/lib/payments/types";
import { db } from "@/lib/db";
import { getPayableGroups } from "@/lib/analytics";
import { MAX_SHOWN, markCommissionsPaid, PAYOUT_ERROR } from "@/lib/commission";

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
  console.warn(
    "Skipping test/lib/payoutSelection.adversarial.test.ts: no reachable test DATABASE_URL.",
  );
}

async function clearDatabase() {
  await db.commission.deleteMany();
  await db.payout.deleteMany();
  await db.referredSubscription.deleteMany();
  await db.click.deleteMany();
  await db.affiliateLink.deleteMany();
  await db.affiliate.deleteMany();
  await db.program.deleteMany();
  await db.paymentConnection.deleteMany();
  await db.merchant.deleteMany();
  await db.owner.deleteMany();
}

async function makeMerchant(ownerId: string) {
  return db.merchant.create({
    data: {
      slug: randomUUID(),
      ownerId,
      name: "Payout selection test merchant",
      domain: "payout-selection-test.example.com",
      websiteUrl: "https://payout-selection-test.example.com",
      paymentConnections: {
        create: {
          provider: PaymentProvider.STRIPE.database,
          apiKeyEnc: "test",
          webhookSecretEnc: "test",
          status: "CONNECTED",
          enabled: true,
        },
      },
    },
  });
}

async function makeAffiliate(merchantId: string, programId: string) {
  return db.affiliate.create({
    data: {
      merchantId,
      programId,
      email: "payout-selection-affiliate@example.com",
      name: "Payout Selection Affiliate",
      links: { create: { code: `selection-${randomUUID()}`, isPrimary: true } },
    },
  });
}

async function makeClick(
  merchantId: string,
  programId: string,
  affiliateId: string,
) {
  return db.click.create({
    data: {
      merchantId,
      programId,
      affiliateId,
      referralToken: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    },
  });
}

async function makeCommission(
  affiliateId: string,
  clickId: string,
  amount: string,
) {
  return db.commission.create({
    data: {
      affiliateId,
      clickId,
      amount,
      grossAmount: amount,
      currency: "usd",
      status: "PAYABLE",
      payableAt: new Date(Date.now() - 60_000),
    },
  });
}

describe.skipIf(!hasDatabase)("adversarial payout selection", () => {
  let ownerId: string;
  let merchantId: string;
  let programId: string;
  let affiliateId: string;
  let clickId: string;

  beforeEach(async () => {
    await clearDatabase();

    const owner = await db.owner.create({
      data: { email: "payout-selection-owner@example.com", passwordHash: "x" },
    });
    ownerId = owner.id;
    const merchant = await makeMerchant(ownerId);
    merchantId = merchant.id;
    const program = await db.program.create({
      data: {
        slug: randomUUID(),
        merchantId,
        name: "Payout Selection Program",
        defaultCommissionRate: "20.00",
        commissionDurationType: "FOREVER",
        attributionWindowDays: 60,
        holdingPeriodDays: 0,
        minimumPayoutAmount: "15.00",
      },
    });
    programId = program.id;
    const affiliate = await makeAffiliate(merchantId, programId);
    affiliateId = affiliate.id;
    const click = await makeClick(merchantId, programId, affiliateId);
    clickId = click.id;
  });

  afterAll(async () => {
    if (hasDatabase) {
      await clearDatabase();
      await db.$disconnect();
    }
  });

  it("records a selected subset when its amount meets the program minimum", async () => {
    await db.program.update({
      where: { id: programId },
      data: { minimumPayoutAmount: "10.00" },
    });
    const first = await makeCommission(affiliateId, clickId, "10.00");
    const second = await makeCommission(affiliateId, clickId, "10.00");
    const leftForLater = await makeCommission(affiliateId, clickId, "10.00");

    const result = await markCommissionsPaid(
      ownerId,
      merchantId,
      [
        { id: first.id, amount: "10.00" },
        { id: second.id, amount: "10.00" },
      ],
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ count: 2, payoutId: expect.any(String) });
    if (!("payoutId" in result)) throw new Error("Payout was not recorded");
    expect(
      (
        await db.payout.findUniqueOrThrow({ where: { id: result.payoutId } })
      ).total.toFixed(2),
    ).toBe("20.00");
    expect(
      await db.commission.findMany({
        where: { id: { in: [first.id, second.id, leftForLater.id] } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, payoutId: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          status: "PAID",
          payoutId: result.payoutId,
        }),
        expect.objectContaining({
          id: second.id,
          status: "PAID",
          payoutId: result.payoutId,
        }),
        expect.objectContaining({
          id: leftForLater.id,
          status: "PAYABLE",
          payoutId: null,
        }),
      ]),
    );
  });

  it("rejects a selected subset below minimum even when the full balance qualifies", async () => {
    const first = await makeCommission(affiliateId, clickId, "10.00");
    const second = await makeCommission(affiliateId, clickId, "10.00");

    const result = await markCommissionsPaid(
      ownerId,
      merchantId,
      [{ id: first.id, amount: "10.00" }],
      new Date().toISOString(),
    );

    expect(result).toEqual({ error: PAYOUT_ERROR.BELOW_MINIMUM });
    expect(await db.payout.count()).toBe(0);
    expect(
      await db.commission.findMany({
        where: { id: { in: [first.id, second.id] } },
        orderBy: { id: "asc" },
        select: { status: true, payoutId: true },
      }),
    ).toEqual([
      { status: "PAYABLE", payoutId: null },
      { status: "PAYABLE", payoutId: null },
    ]);
  });

  it("rejects a commission outside the displayed MAX_SHOWN prefix", async () => {
    await db.program.update({
      where: { id: programId },
      data: { minimumPayoutAmount: "0.00" },
    });
    const createdAt = new Date(Date.now() - 120_000);
    const payableAt = new Date(Date.now() - 60_000);
    const rows = Array.from({ length: MAX_SHOWN + 1 }, () => ({
      affiliateId,
      clickId,
      stripePaymentRef: randomUUID(),
      amount: "0.02",
      grossAmount: "0.02",
      currency: "usd",
      status: "PAYABLE" as const,
      payableAt,
      createdAt,
    }));
    // Keep each insert comfortably below PostgreSQL's bind-parameter limit.
    for (let start = 0; start < rows.length; start += 4_000) {
      await db.commission.createMany({
        data: rows.slice(start, start + 4_000),
      });
    }

    const [group] = await getPayableGroups(ownerId, merchantId);
    const orderedRows = await db.commission.findMany({
      where: { merchantId, affiliateId, programId, status: "PAYABLE" },
      select: { id: true, amount: true },
      orderBy: [{ payableAt: "asc" }, { id: "asc" }],
      take: MAX_SHOWN + 1,
    });
    if (!group) throw new Error("Payout group was not displayed");
    expect(orderedRows).toHaveLength(MAX_SHOWN + 1);
    const outsideDisplayedPrefix = orderedRows[MAX_SHOWN];
    if (!outsideDisplayedPrefix) {
      throw new Error(
        "The commission outside the displayed prefix was missing",
      );
    }

    expect(group.commissions).toHaveLength(MAX_SHOWN);
    expect(group.total).toBe("200.00");
    expect(group.commissionIds).not.toContain(outsideDisplayedPrefix.id);

    const result = await markCommissionsPaid(
      ownerId,
      merchantId,
      [
        {
          id: outsideDisplayedPrefix.id,
          amount: outsideDisplayedPrefix.amount.toFixed(2),
        },
      ],
      new Date().toISOString(),
    );

    expect(result).toEqual({ error: PAYOUT_ERROR.INELIGIBLE });
    expect(await db.payout.count()).toBe(0);
    expect(
      await db.commission.count({
        where: { merchantId, affiliateId, status: "PAID" },
      }),
    ).toBe(0);
  });
});
