import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { brand } from "@tickdoctor/shared";

export const OG_SIZE = { width: 1200, height: 630 } as const;

// Same guard as the status page image: only bundled Geist and only glyphs it covers, so next/og never fetches a
// font or emoji from Google Fonts / jsDelivr. Other characters are dropped.
const SAFE = /[^ -~ -ÿ–—‘’“”…]/g;
const clean = (t: string) => t.replace(SAFE, "").replace(/\s+/g, " ").trim();
const font = (f: string) => readFile(path.join(process.cwd(), "assets", "fonts", f)); // traced via outputFileTracingIncludes in next.config.ts

const cells: [number, number][] = [[0, 4], [1, 4], [2, 3], [3, 1], [4, 6], [5, 4], [6, 4], [7, 4]];

export interface OgCard {
  kicker: string;
  title: string;
  subtitle?: string;
}

export async function renderOgCard({ kicker, title, subtitle }: OgCard): Promise<ImageResponse> {
  const c = brand.colors;
  const unit = 10;
  const [regular, bold] = await Promise.all([font("Geist-Regular.ttf"), font("Geist-Bold.ttf")]);
  const t = clean(title) || brand.name;
  const sub = subtitle ? clean(subtitle) : "";
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
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ position: "relative", width: unit * 8, height: unit * 8, display: "flex" }}>
            {cells.map(([x, y]) => (
              <div key={`${x}-${y}`} style={{ position: "absolute", left: x * unit, top: y * unit, width: unit - 2, height: unit - 2, background: x === 3 ? c.accent : c.text }} />
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700 }}>{brand.name}</div>
          <div style={{ display: "flex", fontSize: 30, color: c.muted, marginLeft: 12 }}>{clean(kicker)}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", fontSize: t.length > 60 ? 56 : t.length > 32 ? 68 : 84, fontWeight: 700, lineHeight: 1.1, maxWidth: 1056 }}>{t}</div>
          {sub ? <div style={{ display: "flex", fontSize: 32, color: c.muted, maxWidth: 1000, lineHeight: 1.3 }}>{sub.length > 140 ? `${sub.slice(0, 137)}...` : sub}</div> : null}
        </div>
        <div style={{ display: "flex", height: 8, width: 160, background: c.accent }} />
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
