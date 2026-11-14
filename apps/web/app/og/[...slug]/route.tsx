import { notFound } from "next/navigation";
import { brand } from "@tickdoctor/shared";
import { DOC_ENTRIES, readDoc } from "@/lib/docs";
import { own } from "@/lib/own";
import { renderOgCard, type OgCard } from "@/lib/og-card";

// /og/<kind> images for public pages. Fixed kinds only (no free-text input), prerendered at build.
// landing, pricing, demo, changelog, legal/<page>, docs[/<page>|/findings[/<rule>]]
export const dynamic = "force-static";
export const dynamicParams = false;

const FIXED: Record<string, OgCard> = {
  landing: { kicker: "", title: brand.tagline, subtitle: "Join the early-access waitlist" },
  pricing: { kicker: "Pricing", title: "Free during the beta", subtitle: "Pro and Network plans add more servers and longer history." },
  demo: { kicker: "Demo", title: "See a real lag investigation", subtitle: "A read-only dashboard with incidents, what changed and findings. No sign-up." },
  changelog: { kicker: "Changelog", title: "What changed, in plain words", subtitle: "Newest first." },
  "legal/privacy": { kicker: "Legal", title: "Privacy policy" },
  "legal/terms": { kicker: "Legal", title: "Terms of service" },
  "legal/mentions-legales": { kicker: "Legal", title: "Mentions légales" },
};

const docKey = (href: string) => (href === "/docs" ? "docs" : href.slice(1));

export function generateStaticParams() {
  return [...Object.keys(FIXED), ...DOC_ENTRIES.map((e) => docKey(e.href))].map((k) => ({ slug: k.split("/") }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const key = (await params).slug.join("/");
  let card = own(FIXED, key);
  if (!card) {
    const e = DOC_ENTRIES.find((d) => docKey(d.href) === key);
    if (!e) notFound();
    const d = await readDoc(e.file, e.label);
    card = { kicker: "Docs", title: d.title, subtitle: d.description };
  }
  return renderOgCard(card);
}
