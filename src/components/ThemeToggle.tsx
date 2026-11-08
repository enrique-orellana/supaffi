"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const subscribeToHydration = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    getClientSnapshot,
    getServerSnapshot,
  );
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-9 w-full justify-start gap-3 px-3 text-sm font-normal",
        className,
      )}
      disabled={!mounted}
      aria-label="Dark mode"
      aria-pressed={isDark}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <Moon aria-hidden="true" />
      <span className="flex-1 text-left">Dark mode</span>
      <span
        aria-hidden="true"
        className={cn(
          "flex h-5 w-9 items-center rounded-full p-0.5 transition-colors",
          isDark ? "bg-primary" : "bg-neutral-300",
        )}
      >
        <span
          className={cn(
            "size-4 rounded-full bg-white shadow-sm transition-transform",
            isDark && "translate-x-4",
          )}
        />
      </span>
    </Button>
  );
}
