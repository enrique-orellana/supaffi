"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  Code2,
  LayoutGrid,
  Percent,
  Receipt,
  Settings,
  Users,
  type LucideIcon,
  Wallet,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ProductSwitcher } from "./ProductSwitcher";
import { AccountMenu } from "./AccountMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { UpdateInfo } from "./VersionNotice";

// The open section is a white row with a hairline; every other row is flat
// on the canvas and only tints on hover. The hairline is an inset shadow so
// the selected row takes no extra layout.
// The primitive centres its badge on a 32px row. Ours are 40px and padded
// 12px, so the badge drops to the row's middle and lines up with the label's
// right padding.
const NAV_BADGE = "right-3 peer-data-[size=default]/menu-button:top-2.5";

const NAV_ROW =
  "h-10 cursor-pointer gap-3 rounded-(--radius) px-3 text-sm text-neutral-700 transition-[background-color,box-shadow,color] duration-150 hover:bg-foreground/[0.04] hover:text-foreground data-active:bg-(--nav-active) data-active:text-foreground data-active:shadow-(--nav-active-shadow) data-active:hover:bg-(--nav-active)";

type Merchant = { id: string; slug: string; name: string; domain: string };

export type Counts = {
  affiliates: number;
  programs: number;
  /** Commissions held for review: the only ledger rows that need a decision. */
  flagged: number;
  /** Payouts ready: one per affiliate and currency. */
  payouts: number;
  tracking: "not-started" | "awaiting-sale" | "verified";
};

type NavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
  badge: number | null;
  trackingStatus?: Counts["tracking"];
};

// The active product comes from the URL, read here rather than in the layout:
// a layout does not re-render when the user moves between two products, so a
// server-picked active product would go stale on the first switch.
export function AppSidebar({
  merchants,
  counts,
  email,
  version,
  update,
}: {
  merchants: Merchant[];
  counts: Record<string, Counts>;
  email: string;
  version: string;
  update: UpdateInfo | null;
}) {
  const pathname = usePathname();
  const activeSlug = pathname.match(/^\/dashboard\/products\/([^/]+)/)?.[1];
  const active = merchants.find((m) => m.slug === activeSlug) ?? null;
  const activeCounts = active ? counts[active.slug] : undefined;
  const base = active ? `/dashboard/products/${active.slug}` : null;

  // Rows for a product that is not open would point nowhere, so there are
  // none. Nothing is greyed out or padlocked; it is simply absent.
  const nav: NavItem[] =
    base && activeCounts
      ? [
          { href: base, icon: Building2, label: "Overview", badge: null },
          {
            href: `${base}/affiliates`,
            icon: Users,
            label: "Affiliates",
            badge: activeCounts.affiliates || null,
          },
          {
            href: `${base}/programs`,
            icon: Percent,
            label: "Programs",
            badge: activeCounts.programs || null,
          },
          {
            href: `${base}/commissions`,
            icon: Receipt,
            label: "Commissions",
            badge: activeCounts.flagged || null,
          },
          {
            href: `${base}/payouts`,
            icon: Wallet,
            label: "Payouts",
            badge: activeCounts.payouts || null,
          },
          {
            href: `${base}/tracking`,
            icon: Code2,
            label: "Tracking",
            badge: null,
            trackingStatus: activeCounts.tracking,
          },
          {
            href: `${base}/settings`,
            icon: Settings,
            label: "Settings",
            badge: null,
          },
        ]
      : [];

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="p-2">
      {/* No top padding: the container's own is what puts the switcher's top
          edge on the same line as the content sheet's. The rule sits halfway
          between the switcher and the first row. */}
      <SidebarHeader className="gap-0 px-3 pt-0 pb-0">
        <ProductSwitcher merchants={merchants} active={active} />
        <div className="my-3 h-px bg-border" aria-hidden />
      </SidebarHeader>

      <SidebarContent className="px-3">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {nav.map((item) => {
                const current =
                  item.href === base
                    ? pathname === base
                    : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={current}
                      className={NAV_ROW}
                      render={<Link href={item.href} />}
                    >
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.badge !== null && (
                      <SidebarMenuBadge
                        className={cn(
                          NAV_BADGE,
                          "text-muted-foreground tabular-nums",
                        )}
                      >
                        {item.badge}
                      </SidebarMenuBadge>
                    )}
                    {item.trackingStatus && (
                      <SidebarMenuBadge
                        title={trackingStatusDescription(item.trackingStatus)}
                        aria-label={`Tracking status: ${trackingStatusLabel(item.trackingStatus)}`}
                        className={cn(
                          NAV_BADGE,
                          "h-6 min-w-0 gap-1.5 rounded-full px-2 text-[11px]",
                          item.trackingStatus === "verified"
                            ? "bg-status-success/10 text-status-success"
                            : "bg-status-warning/10 text-status-warning",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            item.trackingStatus === "verified"
                              ? "bg-status-success"
                              : "bg-status-warning",
                          )}
                        />
                        {trackingStatusLabel(item.trackingStatus)}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1 p-3">
        {merchants.length > 1 && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/dashboard"}
                className={NAV_ROW}
                render={<Link href="/dashboard" />}
              >
                <LayoutGrid className="size-4" />
                <span>All products</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <ThemeToggle />
        <AccountMenu email={email} version={version} update={update} />
      </SidebarFooter>
    </Sidebar>
  );
}

function trackingStatusLabel(status: Counts["tracking"]): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "awaiting-sale":
      return "Awaiting sale";
    case "not-started":
      return "Not set up";
  }
}

function trackingStatusDescription(status: Counts["tracking"]): string {
  switch (status) {
    case "verified":
      return "An attributed checkout has confirmed tracking.";
    case "awaiting-sale":
      return "Referral clicks are recording; an attributed checkout is still needed to verify sales tracking.";
    case "not-started":
      return "Add the tracking script to the product site to begin recording referral clicks.";
  }
}
