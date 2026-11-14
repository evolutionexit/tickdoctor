"use client";

import { usePathname } from "next/navigation";

/** Public pages get the marketing header/footer; /app/* brings its own shell. */
export function SiteChrome({ header, footer, children }: { header: React.ReactNode; footer: React.ReactNode; children: React.ReactNode }) {
  const pathname = usePathname();
  // /s/* status pages are standalone (their own theme, minimal footer).
  if (pathname === "/app" || pathname?.startsWith("/app/") || pathname?.startsWith("/s/")) return <>{children}</>;
  return (
    <>
      {header}
      <main id="main" className="flex-1">
        {children}
      </main>
      {footer}
    </>
  );
}
