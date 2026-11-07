import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const clientLinkComponents = [
  new URL("../../src/app/affiliates/dashboard/links/LinkDialog.tsx", import.meta.url),
  new URL("../../src/app/affiliates/dashboard/links/LinksTable.tsx", import.meta.url),
];

describe("affiliate link client boundary", () => {
  it.each(clientLinkComponents)("keeps server data modules out of %s", (componentUrl) => {
    const source = readFileSync(componentUrl, "utf8");

    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[^\r\n]*from\s+["']@\/lib\/affiliateLink["']/m);
    expect(source).toContain("@/lib/affiliateLinkShared");
  });
});
