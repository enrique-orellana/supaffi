"use client";

import { ThemeProvider } from "next-themes";

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  // next-themes renders its anti-flash script in server HTML. React 19 warns
  // when the same executable script is rendered again on the client, so make
  // only the client copy inert; the server script still applies the theme
  // before hydration.
  const scriptProps =
    typeof window === "undefined"
      ? undefined
      : { type: "application/json" as const };

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      scriptProps={scriptProps}
    >
      {children}
    </ThemeProvider>
  );
}
