import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { requireAffiliate } from "@/lib/affiliateAuth";
import { getAffiliatePayoutDetails } from "@/lib/affiliate";
import { getAffiliateDisplaySettings } from "@/lib/affiliateDisplaySettings";
import { getEcbReferenceRates } from "@/lib/currency";
import { AffiliateSidebar } from "./AffiliateSidebar";

/**
 * The same shell the owner dashboard has: the grounded sidebar at the same
 * width, and the white content sheet beside it, sized to the viewport so a
 * screen is built to fit rather than to scroll.
 */

/** Just the host. A scheme and a trailing slash are noise under a name. */
function siteHost(websiteUrl: string): string {
  try {
    return new URL(websiteUrl).host;
  } catch {
    return websiteUrl;
  }
}

export default async function AffiliateDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { affiliateId, email, merchant } = await requireAffiliate();
  // Warm the request-scoped settings read and the one-day rate snapshot here.
  // Affiliate pages reuse them through React's request cache and Next's fetch
  // cache instead of each view independently resolving currency context.
  const [payoutDetails] = await Promise.all([
    getAffiliatePayoutDetails(affiliateId),
    getAffiliateDisplaySettings(affiliateId, merchant.id),
    getEcbReferenceRates(),
  ]);

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "264px" } as React.CSSProperties}
    >
      <AffiliateSidebar
        merchantName={merchant.name}
        merchantSite={siteHost(merchant.websiteUrl)}
        email={email}
        payoutDetailsMissing={!payoutDetails?.trim()}
      />
      <SidebarInset>
        {/* Screens are built to fit, so this should never scroll. It is a
            safety net, not a layout. */}
        <div className="flex h-svh min-h-0 flex-1 flex-col overflow-y-auto p-8 mb-4 md:h-auto">
          {/* The sidebar is a sheet below md, so it needs something to open
              it. Above md it is always on screen and this would be noise. */}
          <SidebarTrigger className="-mt-2 mb-2 self-start md:hidden" />
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
