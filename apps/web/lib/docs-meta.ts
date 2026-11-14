import type { Metadata } from "next";
import { brand } from "@tickdoctor/shared";
import { pageSocial } from "./og";
import { own } from "./own";
import { readDoc } from "./docs";

// Titles and descriptions follow apps/web/content/phase8-copy.md ("SEO titles and descriptions").
const FIXED: Record<string, { title: string; description?: string }> = {
  "/docs": { title: `Documentation | ${brand.name}`, description: `Install the ${brand.name} plugin, set it up, read what it sends, and fix what it finds. Guides for Paper servers, including small ones.` },
  "/changelog": { title: `Changelog | ${brand.name}`, description: `What changed in ${brand.name} and when, in plain words. Newest first.` },
  "/legal/privacy": { title: `Privacy policy (draft) | ${brand.name}`, description: `What personal data ${brand.name} processes, why, how long we keep it, and how to export or delete it. Working draft, not yet legally reviewed.` },
  "/legal/terms": { title: `Terms of service (draft) | ${brand.name}`, description: `The rules for using ${brand.name}: accounts, plans, the beta, liability and changes. Working draft, not yet legally reviewed.` },
  "/legal/mentions-legales": { title: `Mentions légales (draft) | ${brand.name}`, description: `Legal notice for ${brand.name}: publisher, host and contact. Working draft, to be completed.` },
};

const cut = (t: string) => (t.length <= 160 ? t : `${t.slice(0, 157).replace(/\s+\S*$/, "")}...`);

/** Unique title + description per public docs/legal/changelog page, canonical, OG + Twitter. */
export async function docMetadata(file: string, fallbackTitle: string, path: string, opts: { noindex?: boolean } = {}): Promise<Metadata> {
  const d = await readDoc(file, fallbackTitle);
  const fixed = own(FIXED, path);
  let title: string;
  let description: string;
  if (fixed) {
    title = fixed.title;
    description = fixed.description ?? "";
  } else if (path.startsWith("/docs/findings/")) {
    title = `${d.title}: what it means and how to fix it | ${brand.name}`;
    description = `What the "${d.title}" finding means on a Minecraft server, how to confirm it, and numbered steps to fix it.`;
  } else if (path === "/docs/findings") {
    title = `${d.title} | ${brand.name} docs`;
    description = d.description;
  } else {
    title = `${d.title} | ${brand.name} docs`;
    description = d.description;
  }
  description = cut(description || `${brand.name} documentation: ${d.title}.`);
  return {
    title: { absolute: title },
    description,
    ...(opts.noindex ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical: path },
    ...pageSocial(title, description, path),
  };
}
