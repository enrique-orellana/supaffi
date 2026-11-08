/**
 * Browser-safe analytics choices used by dashboard controls. Keep this module
 * free of database and server-only imports so it can enter client bundles.
 */
export type ChartRange =
  | "today"
  | "yesterday"
  | "this-week"
  | "7d"
  | "this-month"
  | "30d"
  | "12m"
  | "all";

export const CHART_RANGES: { id: ChartRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this-week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
  { id: "this-month", label: "This month" },
  { id: "30d", label: "Last 30 days" },
  { id: "12m", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

export const DEFAULT_RANGE: ChartRange = "30d";

export function isChartRange(value: unknown): value is ChartRange {
  return CHART_RANGES.some((range) => range.id === value);
}

/** The range a page was asked for, or the default when the URL says nothing usable. */
export function rangeFromQuery(
  value: string | string[] | undefined,
): ChartRange {
  return isChartRange(value) ? value : DEFAULT_RANGE;
}

/** The label a header prints for the window, e.g. "Last 30 days". */
export function rangeLabel(range: ChartRange): string {
  return CHART_RANGES.find((item) => item.id === range)!.label;
}
