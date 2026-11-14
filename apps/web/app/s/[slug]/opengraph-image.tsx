import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { brand } from "@tickdoctor/shared";
import { fetchPublicStatus, pct, STATE_VIEW } from "@/lib/public-status";

export const alt = "Server status";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ICONS = {
  healthy: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" strokeWidth="2" />,
  degraded: (
    <>
      <rect x="3" y="3" width="10" height="10" fill="none" stroke="#fff" strokeWidth="1.8" />
      <rect x="3" y="3" width="5" height="10" fill="#fff" />
    </>
  ),
  lagging: (
    <>
      <path d="M8 2.2L14.5 13.5H1.5Z" fill="none" stroke="#fff" strokeWidth="1.8" />
      <rect x="7.2" y="6.2" width="1.6" height="3.6" fill="#fff" />
      <rect x="7.2" y="10.8" width="1.6" height="1.5" fill="#fff" />
    </>
  ),
  offline: <rect x="3" y="3" width="10" height="10" fill="none" stroke="#fff" strokeWidth="1.8" />,
} as const;

// next/og fetches missing glyphs and emoji from Google Fonts / jsDelivr (with the text in the URL). Bundled local fonts
// plus text limited to what they cover means nothing is ever requested remotely. Other characters are dropped.
const SAFE = /[^\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2026]/g;
const clean = (t: string) => t.replace(SAFE, "").replace(/\s+/g, " ").trim() || "Server";
const font = (f: string) => readFile(path.join(process.cwd(), "assets", "fonts", f)); // traced into the standalone build, see next.config.ts

export default async function OpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await fetchPublicStatus(slug).catch(() => null);
  const c = brand.colors;
  const [regular, bold] = await Promise.all([font("Geist-Regular.ttf"), font("Geist-Bold.ttf")]);
  const v = s ? STATE_VIEW[s.state] : null;
  const color = v ? c.health[v.health] : c.muted;
  const facts: string[] = [];
  if (s?.players) facts.push(`${s.players.online}${s.players.max ? ` / ${s.players.max}` : ""} players online`);
  if (s?.uptime?.d7 != null) facts.push(`${pct(s.uptime.d7)} uptime (7 days)`);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: c.background,
          color: c.text,
          fontFamily: "Geist",
          backgroundImage: "linear-gradient(to right, rgba(94,234,212,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(94,234,212,0.08) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, color: c.muted }}>Server status</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", fontSize: s && s.title.length > 28 ? 60 : 84, fontWeight: 800, lineHeight: 1.05, maxWidth: 1056 }}>
            {s ? clean(s.title) : "Status page not found"}
          </div>
          {s && v ? (
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div style={{ display: "flex", width: 96, height: 96, alignItems: "center", justifyContent: "center", background: color }}>
                <svg width="72" height="72" viewBox="0 0 16 16">{ICONS[v.health]}</svg>
              </div>
              <div style={{ display: "flex", fontSize: 76, fontWeight: 800, color }}>{v.word}</div>
            </div>
          ) : null}
          {facts.length ? <div style={{ display: "flex", fontSize: 36, color: c.text }}>{facts.join("   ·   ")}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", height: 8, width: 160, background: c.accent }} />
          {s?.branding ? <div style={{ display: "flex", fontSize: 28, color: c.muted }}>Monitored with {brand.name}</div> : null}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
