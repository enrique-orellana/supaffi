"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAffiliate } from "./signOutAffiliate";
import {
  Building2,
  LinkIcon,
  LogOut,
  Receipt,
  Settings,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { initials } from "@/lib/format";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * The affiliate's shell, on the owner dashboard's own sidebar: same grounded
 * column, same width, same row height and active state. An affiliate is in
 * their partner's house, so the header carries the merchant's name rather than
 * this product's, and there is no product switcher, because there is exactly
 * one merchant: whichever one owns the domain they are on.
 */

// One raised tile for the open section; every other row is flat on the
// canvas and only tints on hover. The tile's edge comes from its shadow, not
// a border, so it reads as lifted rather than outlined.
const NAV_ROW =
  "h-10 cursor-pointer gap-3 rounded-(--radius) px-3 text-sm text-neutral-700 transition-[background-color,box-shadow,color] duration-150 hover:bg-foreground/[0.04] hover:text-foreground data-active:bg-(--nav-active) data-active:text-foreground data-active:shadow-(--nav-active-shadow) data-active:hover:bg-(--nav-active)";

const BASE = "/affiliates/dashboard";

// Five sections, no gating. An affiliate has a link from the moment they sign
// up, so every one of these has something true to show on day one.
const NAV: { key: string; href: string; label: string; icon: LucideIcon }[] = [
  { key: "overview", href: "", label: "Overview", icon: Building2 },
  { key: "links", href: "/links", label: "Links", icon: LinkIcon },
  {
    key: "commissions",
    href: "/commissions",
    label: "Commissions",
    icon: Receipt,
  },
  { key: "payouts", href: "/payouts", label: "Payouts", icon: Wallet },
  { key: "settings", href: "/settings", label: "Settings", icon: Settings },
];

/** The merchant's own mark, the same one the owner's product switcher draws. */
function Mark({ name }: { name: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-700 text-[11px] font-medium text-accent-100">
      {initials(name)}
    </span>
  );
}

export function AffiliateSidebar({
  merchantName,
  merchantSite,
  email,
  payoutDetailsMissing = false,
  pathname: pathnameProp,
}: {
  merchantName: string;
  /** The host of the merchant's site, under their name. */
  merchantSite: string;
  email: string;
  /** Shows a warning badge on Payouts until a destination is saved. */
  payoutDetailsMissing?: boolean;
  /** Overrides the live path, so the shell can be rendered in the dev kit. */
  pathname?: string;
}) {
  const livePathname = usePathname();
  const pathname = pathnameProp ?? livePathname;

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="p-2">
      <SidebarHeader className="gap-0 px-3 pt-0 pb-0">
        <div className="flex h-12 w-full items-center gap-3 px-2.5 text-left">
          <Mark name={merchantName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {merchantName}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {merchantSite}
            </span>
          </span>
        </div>
        <div className="my-3 h-px bg-border" aria-hidden />
      </SidebarHeader>

      <SidebarContent className="px-3">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {NAV.map((item) => {
                const href = `${BASE}${item.href}`;
                const current =
                  item.href === ""
                    ? pathname === BASE
                    : pathname.startsWith(href);
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={current}
                      className={NAV_ROW}
                      render={<Link href={href} />}
                    >
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                      {item.key === "payouts" && payoutDetailsMissing && (
                        <span
                          className="ml-auto shrink-0 rounded-full bg-status-warning-bg px-1.5 py-1 text-[10px] leading-none font-medium whitespace-nowrap text-status-warning"
                          aria-label="Payout details are missing"
                          title="Add payout details in Settings"
                        >
                          Add details
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Who they are signed in as, and the way out. Not a menu: an
          affiliate session has no account screen to put beside it. */}
      <SidebarFooter className="gap-2 p-3">
        <ThemeToggle />
        <div className="flex items-center gap-2.5 px-2">
          <Avatar className="size-8 shrink-0">
            <AvatarFallback>
              {email.charAt(0).toUpperCase() || "?"}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {email}
          </span>
          <form action={signOutAffiliate}>
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer"
              aria-label="Log out"
              title="Log out"
            >
              <LogOut />
            </Button>
          </form>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
