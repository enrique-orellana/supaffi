// The hostname reserved for this Supaffi instance. In a standalone install,
// this is the admin dashboard domain. A private-admin deployment may leave it
// unset and expose only a separate public webhook origin; reserve that host so
// it cannot also be claimed as a Merchant domain. Merchant domains are
// normally issued on demand and gated by /api/internal/domain-check (ADR 0006).
//
// Normalized the same way Merchant.domain is, and for the same reason: every
// runtime comparison is against a real Host header, which arrives lowercase
// and unpadded.
export function instanceDomain(): string {
  const dashboardDomain = (process.env.SUPAFFI_DOMAIN ?? "")
    .trim()
    .toLowerCase();
  if (dashboardDomain) return dashboardDomain;

  const webhookBaseUrl = process.env.SUPAFFI_WEBHOOK_BASE_URL?.trim();
  if (!webhookBaseUrl || !URL.canParse(webhookBaseUrl)) return "";

  const url = new URL(webhookBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return "";
  }

  return url.hostname.toLowerCase();
}
