import { REFERRAL_QUERY_PARAM } from "@/lib/referral";
import { validateCode } from "@/lib/linkCode";

export type LinkInput = { code: string; destinationPath: string };

/** Maximum number of shareable links an affiliate can keep at once. */
export const MAX_LINKS_PER_AFFILIATE = 20;

export type ValidatedLink =
  | { code: string; destinationPath: string | null; error: null }
  | { code?: undefined; destinationPath?: undefined; error: string };

/**
 * Validate the browser-facing fields without importing the database-backed
 * affiliate link service.
 */
export function validateLinkInput(input: LinkInput): ValidatedLink {
  const validatedCode = validateCode(input.code);
  if (validatedCode.error !== null) return { error: validatedCode.error };
  const code = validatedCode.code;

  const raw = input.destinationPath.trim();
  if (raw === "") return { code, destinationPath: null, error: null };

  // A destination is a path on the Merchant's own site. Anything that could
  // read as an absolute or protocol-relative URL would send the Affiliate's
  // traffic somewhere else entirely. A backslash is included because browsers
  // normalize it to a slash, so "/\evil.com" resolves as "//evil.com" too.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return {
      error: "A destination starts with / and points at a page on the site.",
    };
  }
  if (raw.includes("://") || /\s/.test(raw)) {
    return {
      error: "A destination cannot contain spaces or a full web address.",
    };
  }
  // The referral code is appended as its own query parameter. A query string
  // here would double up into "?a=1?via=code", and a fragment would keep the
  // browser from ever sending it to the server, so the link would silently
  // stop earning.
  if (raw.includes("?") || raw.includes("#")) {
    return {
      error: "A destination cannot contain a question mark or a hash symbol.",
    };
  }
  if (raw.length > 200) {
    return { error: "That destination is too long." };
  }

  return { code, destinationPath: raw, error: null };
}

/** The URL an Affiliate actually shares. */
export function linkUrl(
  websiteUrl: string,
  link: { code: string; destinationPath: string | null },
): string {
  const base = websiteUrl.replace(/\/+$/, "");
  const path = link.destinationPath ?? "";
  return `${base}${path}?${REFERRAL_QUERY_PARAM}=${link.code}`;
}
