import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  attributionExpiry,
  clickCommissionTermSnapshot,
  resolveClickCommissionTerms,
  resolveCurrentCommissionTerms,
  type CommissionTermOverrides,
  type CommissionTermProgram,
} from "@/lib/commissionTerms";

const SEED = 0x6c656467;
const CASES = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const DURATION_TYPES = ["FOREVER", "ONE_TIME", "FIXED_MONTHS"] as const;

/** Small deterministic generator; failures include this seed and case index. */
function randomFrom(seed: number) {
  let state = seed >>> 0;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    },
    int(min: number, max: number) {
      return min + (this.next() % (max - min + 1));
    },
    bool() {
      return (this.next() & 1) === 1;
    },
    pick<T>(values: readonly T[]): T {
      return values[this.next() % values.length];
    },
  };
}

function decimalCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100);
}

function programCase(index: number, random: ReturnType<typeof randomFrom>) {
  let commissionDurationType = random.pick(DURATION_TYPES);
  let commissionDurationMonths =
    commissionDurationType === "FIXED_MONTHS" ? random.int(1, 60) : null;
  const program: CommissionTermProgram = {
    id: `program-${index}`,
    defaultCommissionRate: decimalCents(random.int(1, 10_000)),
    commissionDurationType,
    commissionDurationMonths,
    attributionWindowDays: random.int(1, 365),
    holdingPeriodDays: random.int(1, 180),
    minimumPayoutAmount: decimalCents(random.int(0, 1_000_000)),
  };

  const commissionDurationTypeOverride: (typeof DURATION_TYPES)[number] | null =
    random.bool() ? random.pick(DURATION_TYPES) : null;
  let commissionDurationMonthsOverride: number | null = null;
  if (commissionDurationTypeOverride === "FIXED_MONTHS") {
    if (random.bool()) {
      commissionDurationMonthsOverride = random.int(1, 72);
    } else {
      // A blank fixed-month override inherits a month count only when the
      // Program currently supplies one.
      commissionDurationType = "FIXED_MONTHS";
      commissionDurationMonths = random.int(1, 60);
      program.commissionDurationType = commissionDurationType;
      program.commissionDurationMonths = commissionDurationMonths;
    }
  }

  const termsBelongToProgram = random.bool();
  const affiliate: CommissionTermOverrides = {
    programId: termsBelongToProgram ? program.id : `other-program-${index}`,
    customCommissionRate: random.bool()
      ? decimalCents(random.int(1, 10_000))
      : null,
    commissionDurationTypeOverride,
    commissionDurationMonthsOverride,
    attributionWindowDaysOverride: random.bool() ? random.int(1, 365) : null,
    holdingPeriodDaysOverride: random.bool() ? random.int(1, 180) : null,
    // Include explicit zero: it removes this Affiliate's payout threshold.
    minimumPayoutAmountOverride:
      index % 7 === 0
        ? decimalCents(0)
        : random.bool()
          ? decimalCents(random.int(0, 1_000_000))
          : null,
  };
  return { program, affiliate, termsBelongToProgram };
}

describe("commission term resolution under generated inputs", () => {
  it("keeps Affiliate overrides scoped to their Program pair and preserves explicit zero", () => {
    const random = randomFrom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const { program, affiliate, termsBelongToProgram } = programCase(
        index,
        random,
      );
      const context = `seed=0x${SEED.toString(16)} case=${index} program=${program.id} pairMatches=${termsBelongToProgram}`;
      const inherited = resolveCurrentCommissionTerms(program);
      const resolved = resolveCurrentCommissionTerms(program, affiliate);
      const source = termsBelongToProgram ? affiliate : undefined;

      expect(
        resolved.commissionRate.eq(
          source?.customCommissionRate ?? program.defaultCommissionRate,
        ),
        context,
      ).toBe(true);
      expect(resolved.commissionRateSource, context).toBe(
        source?.customCommissionRate ? "affiliate" : "program",
      );
      expect(resolved.attributionWindowDays, context).toBe(
        source?.attributionWindowDaysOverride ?? program.attributionWindowDays,
      );
      expect(resolved.holdingPeriodDays, context).toBe(
        source?.holdingPeriodDaysOverride ?? program.holdingPeriodDays,
      );

      const durationType =
        source?.commissionDurationTypeOverride ??
        program.commissionDurationType;
      expect(resolved.commissionDuration.commissionDurationType, context).toBe(
        durationType,
      );
      expect(
        resolved.commissionDuration.commissionDurationMonths,
        context,
      ).toBe(
        durationType === "FIXED_MONTHS"
          ? (source?.commissionDurationMonthsOverride ??
              program.commissionDurationMonths)
          : null,
      );
      expect(
        resolved.minimumPayoutAmount.eq(
          source?.minimumPayoutAmountOverride ?? program.minimumPayoutAmount,
        ),
        context,
      ).toBe(true);

      if (!termsBelongToProgram) {
        expect(resolved, context).toEqual(inherited);
      }
      if (source?.minimumPayoutAmountOverride?.isZero()) {
        expect(resolved.minimumPayoutAmount.isZero(), context).toBe(true);
      }
    }
  });

  it("freezes the rate, duration and hold captured by a Click as live terms change", () => {
    const random = randomFrom(SEED ^ 0x51a7e);
    for (let index = 0; index < CASES; index += 1) {
      const { program, affiliate } = programCase(index, random);
      const before = resolveCurrentCommissionTerms(program, affiliate);
      const snapshot = clickCommissionTermSnapshot(before);
      const laterProgram: CommissionTermProgram = {
        ...program,
        defaultCommissionRate: decimalCents(random.int(1, 10_000)),
        commissionDurationType: "FOREVER",
        commissionDurationMonths: null,
        holdingPeriodDays: random.int(181, 360),
      };
      const laterAffiliate: CommissionTermOverrides = {
        ...affiliate,
        customCommissionRate: decimalCents(random.int(1, 10_000)),
        commissionDurationTypeOverride: "ONE_TIME",
        commissionDurationMonthsOverride: null,
        holdingPeriodDaysOverride: random.int(181, 360),
      };
      const resolved = resolveClickCommissionTerms(
        laterProgram,
        laterAffiliate,
        snapshot,
      );
      const context = `seed=0x${(SEED ^ 0x51a7e).toString(16)} case=${index} click=${program.id}`;

      expect(resolved.commissionRate.eq(before.commissionRate), context).toBe(
        true,
      );
      expect(resolved.commissionDuration, context).toEqual(
        before.commissionDuration,
      );
      expect(resolved.holdingPeriodDays, context).toBe(
        before.holdingPeriodDays,
      );
    }
  });

  it("adds an exact UTC-day window across leap and DST-adjacent dates", () => {
    const random = randomFrom(SEED ^ 0x44a71b);
    const anchors = [
      new Date("2024-02-28T23:59:59.999Z"),
      new Date("2024-03-30T23:30:00.000Z"),
      new Date("2024-10-26T00:30:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    ];

    for (let index = 0; index < CASES; index += 1) {
      const createdAt = new Date(
        anchors[index % anchors.length].getTime() +
          random.int(0, 400) * DAY_MS +
          random.int(0, DAY_MS - 1),
      );
      const windowDays = random.int(1, 365);
      const expiry = attributionExpiry(createdAt, windowDays);
      const context = `seed=0x${(SEED ^ 0x44a71b).toString(16)} case=${index} days=${windowDays}`;

      expect(expiry.getTime() - createdAt.getTime(), context).toBe(
        windowDays * DAY_MS,
      );
    }
  });
});
