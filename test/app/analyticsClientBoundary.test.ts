import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rangePicker = new URL("../../src/components/charts/RangePicker.tsx", import.meta.url);

describe("analytics client boundary", () => {
  it("keeps database-backed analytics out of the client bundle", () => {
    const source = readFileSync(rangePicker, "utf8");

    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[^\r\n]*from\s+["']@\/lib\/analytics["']/m);
    expect(source).toContain("@/lib/analyticsShared");
  });
});
