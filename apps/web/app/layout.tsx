import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { brand } from "@tickdoctor/shared";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SiteChrome } from "@/components/site-chrome";
import { baseOpenGraph, baseTwitter } from "@/lib/og";
import { meta, siteUrl } from "@/lib/site";
import { themeCss, themeInitScript } from "@/lib/theme-css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: meta.home.title,
  description: meta.home.description,
  applicationName: brand.name,
  openGraph: { ...baseOpenGraph, title: meta.home.title, description: meta.home.description, images: [{ url: "/og/landing", width: 1200, height: 630, alt: meta.home.title }] },
  twitter: { ...baseTwitter, title: meta.home.title, description: meta.home.description, images: ["/og/landing"] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: brand.colors.background },
    { media: "(prefers-color-scheme: light)", color: "#f5f8fa" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss }} />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-fg"
        >
          Skip to main content
        </a>
        <SiteChrome header={<Header />} footer={<Footer />}>
          {children}
        </SiteChrome>
      </body>
    </html>
  );
}
