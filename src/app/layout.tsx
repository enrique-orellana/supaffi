import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppThemeProvider } from "@/components/AppThemeProvider";

export const metadata = {
  title: "Supaffi",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        <AppThemeProvider>
          {/* Grouping: once one tooltip is open, moving to an adjacent trigger
              swaps instantly instead of re-running the open sequence. */}
          <TooltipProvider delay={0} closeDelay={0}>
            {children}
          </TooltipProvider>
          <Toaster />
        </AppThemeProvider>
      </body>
    </html>
  );
}
