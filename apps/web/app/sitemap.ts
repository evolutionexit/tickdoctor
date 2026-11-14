import type { MetadataRoute } from "next";
import { DOCS_PAGES, RULE_IDS } from "@tickdoctor/shared";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  // Public pages only: no /s/* (status pages are noindex until go-public), no /app.
  const paths = [
    "/",
    "/pricing",
    "/demo",
    "/changelog",
    "/docs",
    ...DOCS_PAGES.filter((p) => p !== "index").map((p) => `/docs/${p}`),
    "/docs/findings",
    ...RULE_IDS.map((r) => `/docs/findings/${r}`),
  ];
  return paths.map((p) => ({ url: `${siteUrl}${p}`, changeFrequency: "weekly", priority: p === "/" ? 1 : 0.5 }));
}
