import Link from "next/link";
import { Fragment } from "react";
import { CopyButton } from "./ui";
import { safeLink } from "@/lib/safe-link";

/**
 * Small, safe Markdown renderer. The compact variant (default) is for suggestedFix: paragraphs, lists, fenced code, `code`,
 * **bold**, https links. The "doc" variant (docs pages) adds real headings with anchors, tables, block quotes, rules,
 * nested bullets, italics, root-relative links and fenced code with a language label + copy button.
 * It builds React elements only. Raw HTML is shown as plain text, never parsed.
 */
export function Inline({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![*\w])\*[^*\s][^*\n]*\*(?![*\w])|\[[^\]\n]+\]\([^\s)]*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={k++} className="inline">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else {
      const lm = /^\[([^\]\n]+)\]\(([^\s)]*)\)$/.exec(t)!;
      const cls = "text-accent-text underline underline-offset-2";
      const link = safeLink(lm[2]!);
      if (!link) out.push(<Fragment key={k++}>{t}</Fragment>); // not a link we produce: plain text
      else if (link.kind === "internal") out.push(<Link key={k++} href={link.href} className={cls}>{lm[1]}</Link>);
      else out.push(<a key={k++} href={link.href} target="_blank" rel="noopener noreferrer" className={cls}>{lm[1]}</a>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

type Align = "left" | "right" | "center";
type Block =
  | { t: "p"; text: string }
  | { t: "ol" | "ul"; items: { text: string; sub: string[] }[] }
  | { t: "code"; text: string; lang: string }
  | { t: "h"; text: string; level: number }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { t: "quote"; text: string; paras: string[] }
  | { t: "hr" };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
const isRule = (l: string) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
const isTableSep = (l: string | undefined) => !!l && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("|");
const startsBlock = (l: string) =>
  /^\s*(\d+[.)]|[-*])\s/.test(l) || l.trim().startsWith("```") || /^#{1,6}\s/.test(l) || l.startsWith(">") || isRule(l);

export function parse(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ t: "h", text: line.replace(/^#{1,6}\s+/, "").trim(), level: /^#+/.exec(line)![0].length });
      i++;
    } else if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) buf.push(lines[i++]!);
      i++;
      blocks.push({ t: "code", text: buf.join("\n"), lang });
    } else if (isRule(line)) {
      blocks.push({ t: "hr" });
      i++;
    } else if (line.trimStart().startsWith("|") && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map<Align>((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
      blocks.push({ t: "table", head, align, rows });
    } else if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      const paras = buf.join("\n").split(/\n\s*\n/).map((p) => p.replace(/^#{1,6}\s+/, "").replace(/\n/g, " ").trim()).filter(Boolean);
      blocks.push({ t: "quote", text: paras.join(" "), paras });
    } else if (/^\s*\d+[.)]\s/.test(line) || /^\s*[-*]\s/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items: { text: string; sub: string[] }[] = [];
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length) {
        const l = lines[i]!;
        if (re.test(l) && !/^\s{2,}/.test(l)) {
          items.push({ text: l.replace(re, ""), sub: [] });
          i++;
        } else if (items.length && /^\s{2,}[-*]\s/.test(l)) {
          items[items.length - 1]!.sub.push(l.replace(/^\s+[-*]\s+/, ""));
          i++;
        } else if (items.length && /^\s{2,}\S/.test(l)) {
          items[items.length - 1]!.text += ` ${l.trim()}`; // wrapped continuation line
          i++;
        } else break;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) buf.push(lines[i++]!);
      if (!buf.length) buf.push(lines[i++]!);
      blocks.push({ t: "p", text: buf.join(" ") });
    }
  }
  return blocks;
}

export const slugify = (t: string) =>
  t.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function CodeFence({ text, lang }: { text: string; lang: string }) {
  return (
    <div className="my-4 rounded-md border border-line bg-bg">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1">
        <span className="font-mono text-xs uppercase tracking-wide text-muted">{lang || "text"}</span>
        <CopyButton text={text} label="Copy" className="btn btn-ghost btn-sm !min-h-8" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-sm leading-relaxed" tabIndex={0}>{text}</pre>
    </div>
  );
}

const H_CLASS = [
  "",
  "mt-10 text-3xl font-bold tracking-tight",
  "mt-10 scroll-mt-24 border-b border-line pb-2 text-2xl font-bold tracking-tight",
  "mt-8 scroll-mt-24 text-xl font-semibold",
  "mt-6 scroll-mt-24 text-lg font-semibold",
  "mt-5 scroll-mt-24 text-base font-semibold",
  "mt-5 scroll-mt-24 text-sm font-semibold",
];

function DocBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-4 leading-relaxed [&>:first-child]:mt-0">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const lvl = Math.min(6, Math.max(2, b.level)); // the page title is the only h1
            const Tag = `h${lvl}` as "h2";
            return (
              <Tag key={i} id={slugify(b.text)} className={H_CLASS[lvl]}>
                <Inline text={b.text} />
              </Tag>
            );
          }
          case "p":
            return <p key={i}><Inline text={b.text} /></p>;
          case "code":
            return <CodeFence key={i} text={b.text} lang={b.lang} />;
          case "hr":
            return <hr key={i} className="my-8 border-line" />;
          case "quote":
            return (
              <blockquote key={i} className="border-l-4 border-[var(--accent)] bg-surface px-4 py-3 text-sm text-muted">
                {b.paras.map((p, j) => <p key={j} className={j ? "mt-2" : ""}><Inline text={p} /></p>)}
              </blockquote>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-md border border-line" tabIndex={0} role="region" aria-label="Table">
                <table className="w-full min-w-max border-collapse text-sm">
                  <thead className="bg-surface-2 text-left">
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} scope="col" className="border-b border-line px-3 py-2 font-semibold" style={{ textAlign: b.align[j] }}><Inline text={h} /></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.head.map((_, c) => (
                          <td key={c} className="px-3 py-2 align-top" style={{ textAlign: b.align[c] }}><Inline text={r[c] ?? ""} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "ol":
          case "ul": {
            const List = b.t;
            return (
              <List key={i} className={`${b.t === "ol" ? "list-decimal" : "list-disc"} space-y-2 pl-6 marker:text-muted`}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it.text} />
                    {it.sub.length ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 marker:text-muted">
                        {it.sub.map((x, k) => <li key={k}><Inline text={x} /></li>)}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}

export function Markdown({ md, variant = "compact" }: { md: string; variant?: "compact" | "doc" }) {
  if (variant === "doc") return <DocBlocks blocks={parse(md)} />;
  return (
    <div className="space-y-2">
      {parse(md).map((b, i) => {
        if (b.t === "h") return <h5 key={i} className="pt-1 text-sm font-semibold"><Inline text={b.text} /></h5>;
        if (b.t === "p")
          return <p key={i} className={/^Optional, for when/i.test(b.text) ? "border-t border-line pt-3 text-xs font-semibold uppercase tracking-wide text-muted" : undefined}><Inline text={b.text} /></p>;
        if (b.t === "code") return <pre key={i} className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-xs leading-relaxed" tabIndex={0}>{b.text}</pre>;
        if (b.t === "ol")
          return (
            <ol key={i} className="list-decimal space-y-2 pl-5 marker:text-muted">
              {b.items.map((it, j) => <li key={j}><Inline text={it.text} /></li>)}
            </ol>
          );
        if (b.t === "ul")
          return (
            <ul key={i} className="list-disc space-y-2 pl-5 marker:text-muted">
              {b.items.map((it, j) => <li key={j}><Inline text={it.text} /></li>)}
            </ul>
          );
        if (b.t === "quote" || b.t === "table" || b.t === "hr") return <p key={i}>{b.t === "quote" ? <Inline text={b.text} /> : null}</p>;
        return null;
      })}
    </div>
  );
}
