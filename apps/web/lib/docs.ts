import { readFile } from "node:fs/promises";
import path from "node:path";
import { DOCS_PAGES, RULE_IDS } from "@tickdoctor/shared";

// Docs are Markdown written by the copywriter in apps/web/content/docs/ (+ content/changelog.md), read at build time.
// A missing file renders a "Coming soon" stub, so the routes build before the content lands.

const root = () => {
  const cwd = process.cwd();
  return cwd.endsWith(path.join("apps", "web")) ? cwd : path.join(cwd, "apps", "web");
};

export interface Doc {
  title: string;
  description: string;
  body: string;
  missing: boolean;
}

export function parseFrontMatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]!] = v;
  }
  return { data, body: raw.slice(m[0].length) };
}

export async function readDoc(rel: string, fallbackTitle: string): Promise<Doc> {
  try {
    const raw = await readFile(path.join(root(), rel), "utf8");
    const { data, body } = parseFrontMatter(raw);
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    // The page renders the title as its own h1, so drop a leading "# Title" from the body.
    const cleaned = body.replace(/^#\s+.+\n+/m, "");
    return { title: data.title || h1 || fallbackTitle, description: data.description ?? "", body: cleaned, missing: false };
  } catch {
    return { title: fallbackTitle, description: "", body: "", missing: true };
  }
}

export interface DocEntry {
  href: string;
  /** file under apps/web/ */
  file: string;
  label: string;
  group: "Guides" | "Findings reference";
}

const GUIDE_LABELS: Record<(typeof DOCS_PAGES)[number], string> = {
  index: "Overview",
  install: "Install the plugin",
  configuration: "Configuration",
  "data-and-privacy": "Data and privacy",
  troubleshooting: "Troubleshooting",
  faq: "FAQ",
};

export const ruleLabel = (id: string) => id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

export const DOC_ENTRIES: DocEntry[] = [
  ...DOCS_PAGES.map<DocEntry>((p) => ({
    href: p === "index" ? "/docs" : `/docs/${p}`,
    file: `content/docs/${p}.md`,
    label: GUIDE_LABELS[p],
    group: "Guides",
  })),
  { href: "/docs/findings", file: "content/docs/findings/index.md", label: "All findings", group: "Findings reference" },
  ...RULE_IDS.map<DocEntry>((r) => ({ href: `/docs/findings/${r}`, file: `content/docs/findings/${r}.md`, label: ruleLabel(r), group: "Findings reference" })),
];

/** Entries with real titles (front matter) for the sidebar and prev/next. */
export async function docNav(): Promise<(DocEntry & { title: string })[]> {
  return Promise.all(DOC_ENTRIES.map(async (e) => ({ ...e, title: (await readDoc(e.file, e.label)).title })));
}
