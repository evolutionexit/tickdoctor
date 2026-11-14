import type { Metadata } from "next";
import { brand } from "@tickdoctor/shared";

/** Shared base for per-page metadata: spread these, then override title/description/url. */
export const baseOpenGraph = {
  type: "website",
  siteName: brand.name,
} as const;

export const baseTwitter = { card: "summary_large_image" } as const;

/** Per-page-type OG image: /og/landing, /og/pricing, /og/demo, /og/changelog, /og/legal/<page>, /og/docs/<page>. */
export function ogImageFor(path: string): string {
  if (path === "/") return "/og/landing";
  return `/og${path}`;
}

export function pageSocial(title: string, description: string | undefined, path: string): Pick<Metadata, "openGraph" | "twitter"> {
  const ogImage = { url: ogImageFor(path), width: 1200, height: 630, alt: title };
  return {
    openGraph: { ...baseOpenGraph, title, ...(description ? { description } : {}), url: path, images: [ogImage] },
    twitter: { ...baseTwitter, title, ...(description ? { description } : {}), images: [ogImage.url] },
  };
}
