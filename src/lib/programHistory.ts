export type ProgramHistorySnapshot = {
  name: string;
  defaultCommissionRate: string;
  commissionDurationType: "ONE_TIME" | "FIXED_MONTHS" | "FOREVER";
  commissionDurationMonths: number | null;
  attributionWindowDays: number;
  holdingPeriodDays: number;
  currency: string;
  minimumPayoutAmount: string;
  signupOpen: boolean;
};

export type ProgramHistoryChange = {
  key:
    | "name"
    | "defaultCommissionRate"
    | "commissionDuration"
    | "attributionWindowDays"
    | "holdingPeriodDays"
    | "currency"
    | "minimumPayoutAmount"
    | "signupOpen";
  label: string;
  before: string;
  after: string;
};

export type ProgramEditHistoryEntry = {
  id: string;
  createdAt: string;
  actorEmail: string;
  beforeValues: ProgramHistorySnapshot;
  afterValues: ProgramHistorySnapshot;
};

function formatRate(value: string): string {
  return `${value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}%`;
}

function formatDuration(
  type: ProgramHistorySnapshot["commissionDurationType"],
  months: number | null,
): string {
  if (type === "ONE_TIME") return "First payment";
  if (type === "FOREVER") return "Forever";
  if (months === null) return "Fixed term";
  return `${months} month${months === 1 ? "" : "s"}`;
}

function formatMinimum(value: string): string {
  return `${value} in each transaction currency`;
}

/** Summarize only the settings that changed between two saved Program versions. */
export function programHistoryChanges(
  before: ProgramHistorySnapshot,
  after: ProgramHistorySnapshot,
): ProgramHistoryChange[] {
  const changes: ProgramHistoryChange[] = [];

  if (before.name !== after.name) {
    changes.push({
      key: "name",
      label: "Program name",
      before: before.name,
      after: after.name,
    });
  }
  if (before.defaultCommissionRate !== after.defaultCommissionRate) {
    changes.push({
      key: "defaultCommissionRate",
      label: "Commission rate",
      before: formatRate(before.defaultCommissionRate),
      after: formatRate(after.defaultCommissionRate),
    });
  }
  if (
    before.commissionDurationType !== after.commissionDurationType ||
    before.commissionDurationMonths !== after.commissionDurationMonths
  ) {
    changes.push({
      key: "commissionDuration",
      label: "Commission duration",
      before: formatDuration(
        before.commissionDurationType,
        before.commissionDurationMonths,
      ),
      after: formatDuration(
        after.commissionDurationType,
        after.commissionDurationMonths,
      ),
    });
  }
  if (before.attributionWindowDays !== after.attributionWindowDays) {
    changes.push({
      key: "attributionWindowDays",
      label: "Attribution window",
      before: `${before.attributionWindowDays} days`,
      after: `${after.attributionWindowDays} days`,
    });
  }
  if (before.holdingPeriodDays !== after.holdingPeriodDays) {
    changes.push({
      key: "holdingPeriodDays",
      label: "Hold before paying",
      before: `${before.holdingPeriodDays} days`,
      after: `${after.holdingPeriodDays} days`,
    });
  }
  if (before.currency !== after.currency) {
    changes.push({
      key: "currency",
      label: "Dashboard currency",
      before: before.currency.toUpperCase(),
      after: after.currency.toUpperCase(),
    });
  }
  if (before.minimumPayoutAmount !== after.minimumPayoutAmount) {
    changes.push({
      key: "minimumPayoutAmount",
      label: "Minimum payout",
      before: formatMinimum(before.minimumPayoutAmount),
      after: formatMinimum(after.minimumPayoutAmount),
    });
  }
  if (before.signupOpen !== after.signupOpen) {
    changes.push({
      key: "signupOpen",
      label: "Signup access",
      before: before.signupOpen ? "Public" : "Invite only",
      after: after.signupOpen ? "Public" : "Invite only",
    });
  }

  return changes;
}
