"use client";

import { useEffect, useRef } from "react";
import type uPlotType from "uplot";
import "uplot/dist/uPlot.min.css";
import { useResolvedTheme } from "@/lib/use-theme";

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** colours per theme: Okabe-Ito-based, so blue/orange stay distinguishable for colour-blind users */
  color: { dark: string; light: string };
  width?: number;
  dash?: number[];
  scale?: "y" | "y2";
  step?: boolean;
  unit?: string;
  digits?: number;
}
export interface ChartBand {
  from: number; // unix s
  to: number;
  label: string;
  /** Click on the band opens this link (incident page). */
  href?: string;
}
export interface ChartThreshold {
  value: number;
  label: string;
}
interface Props {
  xs: number[];
  series: ChartSeries[];
  range: [number, number];
  bands?: ChartBand[];
  thresholds?: ChartThreshold[];
  yRange: (dataMax: number) => [number, number];
  y2Range?: (dataMax: number) => [number, number];
  height?: number;
  ariaLabel: string;
  onBandClick?: (b: ChartBand) => void;
  /** Cap the left axis at max(100, p98 of the visible values × 1.3); taller spikes are clipped, marked and labelled. */
  clipSpikes?: boolean;
}

/** Upper bound of the clipped axis, or null when the data fits anyway. Exported for tests and the note. */
export function clipBound(series: ChartSeries[]): number | null {
  const vals = series.filter((s) => (s.scale ?? "y") === "y").flatMap((s) => s.values.filter((v): v is number => v !== null)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const p98 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))]!;
  const top = Math.ceil(Math.max(100, p98 * 1.3) / 10) * 10;
  return vals[vals.length - 1]! > top ? top : null;
}

const PALETTE = {
  dark: { axis: "#a3adb8", grid: "rgba(139,148,158,0.16)", band: "rgba(217,70,239,0.16)", bandBar: "#e879f9", threshold: "#c9d1d9", tipBg: "#161b22", tipFg: "#e6edf3" },
  light: { axis: "#4b5560", grid: "rgba(14,17,22,0.10)", band: "rgba(162,28,175,0.12)", bandBar: "#a21caf", threshold: "#2b333b", tipBg: "#ffffff", tipFg: "#0e1116" },
};

type Pal = (typeof PALETTE)["dark"];
type Theme = keyof typeof PALETTE;
type UPlot = typeof uPlotType;

const seriesMax = (series: ChartSeries[], scale: "y" | "y2") =>
  Math.max(0, ...series.filter((s) => (s.scale ?? "y") === scale).flatMap((s) => s.values.filter((v): v is number => v !== null)));

function createTip(pal: Pal): HTMLDivElement {
  const tip = document.createElement("div");
  tip.setAttribute("aria-hidden", "true");
  Object.assign(tip.style, {
    position: "absolute", display: "none", pointerEvents: "none", zIndex: "5", padding: "6px 8px", borderRadius: "6px",
    border: `1px solid ${pal.grid}`, background: pal.tipBg, color: pal.tipFg, fontSize: "12px", lineHeight: "1.45",
    boxShadow: "0 4px 14px rgba(0,0,0,.25)", whiteSpace: "nowrap", fontFamily: "var(--font-geist-mono), monospace",
  });
  return tip;
}

function drawBands(u: uPlotType, bands: ChartBand[], pal: Pal) {
  const { ctx, bbox } = u;
  ctx.save();
  for (const b of bands) {
    const x0 = Math.max(bbox.left, u.valToPos(b.from, "x", true));
    const x1 = Math.min(bbox.left + bbox.width, u.valToPos(b.to, "x", true));
    if (x1 < bbox.left || x0 > bbox.left + bbox.width) continue;
    const w = Math.max(3, x1 - x0);
    ctx.fillStyle = pal.band;
    ctx.fillRect(x0, bbox.top, w, bbox.height);
    ctx.fillStyle = pal.bandBar;
    ctx.fillRect(x0, bbox.top, w, 3 * devicePixelRatio);
  }
  ctx.restore();
}

function drawThresholds(u: uPlotType, thresholds: ChartThreshold[], pal: Pal) {
  const { ctx, bbox } = u;
  ctx.strokeStyle = pal.threshold;
  ctx.fillStyle = pal.threshold;
  ctx.lineWidth = 1.25 * devicePixelRatio;
  ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  ctx.font = `${11 * devicePixelRatio}px system-ui`;
  for (const t of thresholds) {
    const y = u.valToPos(t.value, "y", true);
    if (y < bbox.top || y > bbox.top + bbox.height) continue;
    ctx.beginPath();
    ctx.moveTo(bbox.left, y);
    ctx.lineTo(bbox.left + bbox.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "right";
    ctx.fillText(t.label, bbox.left + bbox.width - 4 * devicePixelRatio, y - 4 * devicePixelRatio);
    ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  }
}

function drawClipMarkers(u: uPlotType, xs: number[], series: ChartSeries[], clipTop: number, theme: Theme, pal: Pal) {
  const { ctx, bbox } = u;
  // Marker at the top for every clipped point; label the tallest with its real value.
  const d = devicePixelRatio;
  ctx.setLineDash([]);
  let tall: { x: number; v: number; color: string } | null = null;
  series.forEach((sr, si) => {
    if ((sr.scale ?? "y") !== "y") return;
    sr.values.forEach((v, i) => {
      if (v === null || v <= clipTop) return;
      const x = u.valToPos(xs[i]!, "x", true);
      if (x < bbox.left || x > bbox.left + bbox.width) return;
      ctx.fillStyle = sr.color[theme];
      ctx.beginPath();
      ctx.moveTo(x, bbox.top + 1 * d);
      ctx.lineTo(x - 5 * d, bbox.top + 9 * d);
      ctx.lineTo(x + 5 * d, bbox.top + 9 * d);
      ctx.closePath();
      ctx.fill();
      if (si === 0 && (!tall || v > tall.v)) tall = { x, v, color: sr.color[theme] };
    });
  });
  const t = tall as { x: number; v: number } | null;
  if (t) {
    const label = `↑ ${Math.round(t.v).toLocaleString("en-GB").replace(/,/g, "\u202f")} ${series[0]?.unit ?? ""}`.trim();
    ctx.font = `600 ${11 * d}px system-ui`;
    ctx.fillStyle = pal.tipFg === "#e6edf3" ? "#e6edf3" : "#0e1116";
    const w = ctx.measureText(label).width;
    const lx = Math.min(Math.max(t.x, bbox.left + w / 2 + 4 * d), bbox.left + bbox.width - w / 2 - 4 * d);
    ctx.textAlign = "center";
    ctx.fillText(label, lx, bbox.top + 22 * d);
  }
}

function drawOverlay(u: uPlotType, o: { xs: number[]; series: ChartSeries[]; thresholds: ChartThreshold[]; clipTop: number | null; theme: Theme; pal: Pal }) {
  u.ctx.save();
  drawThresholds(u, o.thresholds, o.pal);
  if (o.clipTop !== null) drawClipMarkers(u, o.xs, o.series, o.clipTop, o.theme, o.pal);
  u.ctx.restore();
}

function updateTip(u: uPlotType, tip: HTMLDivElement, series: ChartSeries[], bands: ChartBand[], theme: Theme) {
  const idx = u.cursor.idx;
  const left = u.cursor.left ?? -1;
  if (idx === null || idx === undefined || left < 0) {
    tip.style.display = "none";
    return;
  }
  const t = u.data[0][idx];
  const cursorT = u.posToVal(left, "x");
  const band = bands.find((b) => cursorT >= b.from - 60 && cursorT <= b.to + 60);
  tip.replaceChildren();
  const head = document.createElement("div");
  head.style.opacity = "0.75";
  head.textContent = new Date((t ?? 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  tip.appendChild(head);
  let any = false;
  series.forEach((s, i) => {
    const v = u.data[i + 1]?.[idx];
    if (v === null || v === undefined) return;
    any = true;
    const row = document.createElement("div");
    const dot = document.createElement("span");
    dot.textContent = s.step ? "▬ " : s.dash ? "╌ " : "━ ";
    dot.style.color = s.color[theme];
    row.append(dot, `${s.label}: ${v.toFixed(s.digits ?? 1)}${s.unit ? ` ${s.unit}` : ""}`);
    tip.appendChild(row);
  });
  if (!any && !band) {
    const row = document.createElement("div");
    row.textContent = "No data (server offline)";
    tip.appendChild(row);
  }
  u.over.style.cursor = band?.href ? "pointer" : "";
  if (band) {
    const row = document.createElement("div");
    row.style.marginTop = "4px";
    row.style.fontWeight = "600";
    row.textContent = band.label + (band.href ? " (click to open)" : "");
    tip.appendChild(row);
  }
  tip.style.display = "block";
  const w = tip.offsetWidth;
  const over = u.over.clientWidth;
  tip.style.left = `${left + 12 + w > over ? Math.max(0, left - 12 - w) : left + 12}px`;
  tip.style.top = "6px";
}

function buildAxes(hasY2: boolean, pal: Pal): uPlotType.Axis[] {
  return [
    { stroke: pal.axis, grid: { stroke: pal.grid, width: 1 }, ticks: { stroke: pal.grid }, font: "12px system-ui" },
    { scale: "y", stroke: pal.axis, grid: { stroke: pal.grid, width: 1 }, ticks: { stroke: pal.grid }, size: 44, font: "12px system-ui" },
    ...(hasY2
      ? [{
          scale: "y2", side: 1, stroke: pal.axis, grid: { show: false }, ticks: { stroke: pal.grid }, size: 36, font: "12px system-ui",
          values: (_u: uPlotType, vals: number[]) => vals.map((v) => (Number.isInteger(v) ? String(v) : "")),
        }]
      : []),
  ];
}

function buildSeries(uPlot: UPlot, series: ChartSeries[], theme: Theme): uPlotType.Series[] {
  return [
    {},
    ...series.map((s): uPlotType.Series => ({
      label: s.label,
      scale: s.scale ?? "y",
      stroke: s.color[theme],
      width: s.width ?? 1.75,
      dash: s.dash,
      spanGaps: false,
      paths: s.step ? uPlot.paths.stepped!({ align: 1 }) : undefined,
      points: { show: false },
    })),
  ];
}

function summarize(series: ChartSeries[]): string {
  return series
    .map((s) => {
      const nums = s.values.filter((v): v is number => v !== null && v !== undefined);
      if (nums.length === 0) return `${s.label}: no data.`;
      const f = (n: number) => `${n.toFixed(s.digits ?? 1)}${s.unit ? " " + s.unit : ""}`;
      return `${s.label}: latest ${f(nums[nums.length - 1] as number)}, lowest ${f(Math.min(...nums))}, highest ${f(Math.max(...nums))}.`;
    })
    .join(" ");
}

export function TimeChart({ xs, series, range, bands = [], thresholds = [], yRange, y2Range, height = 220, ariaLabel, onBandClick, clipSpikes }: Props) {
  const clipTop = clipSpikes ? clipBound(series) : null;
  const host = useRef<HTMLDivElement>(null);
  const clickRef = useRef(onBandClick);
  clickRef.current = onBandClick;
  const theme = useResolvedTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let plot: uPlotType | null = null;
    let ro: ResizeObserver | null = null;
    const pal = PALETTE[theme];

    void import("uplot").then(({ default: uPlot }) => {
      if (disposed || !el) return;
      const hasY2 = series.some((s) => s.scale === "y2");
      const tip = createTip(pal);

      const opts: uPlotType.Options = {
        width: el.clientWidth || 600,
        height,
        legend: { show: false },
        padding: [10, hasY2 ? 4 : 10, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { size: 7 } },
        scales: {
          x: { time: true, range: () => range },
          y: { range: () => (clipTop !== null ? [0, clipTop] : yRange(Math.max(seriesMax(series, "y"), ...thresholds.map((t) => t.value) , 0))) },
          ...(hasY2 && y2Range ? { y2: { range: () => y2Range(seriesMax(series, "y2")) } } : {}),
        },
        axes: buildAxes(hasY2, pal),
        series: buildSeries(uPlot, series, theme),
        hooks: {
          drawClear: [(u) => drawBands(u, bands, pal)],
          draw: [(u) => drawOverlay(u, { xs, series, thresholds, clipTop, theme, pal })],
          init: [
            (u) => {
              u.over.appendChild(tip);
              u.over.addEventListener("click", () => {
                const left = u.cursor.left ?? -1;
                if (left < 0 || !clickRef.current) return;
                const t = u.posToVal(left, "x");
                const hit = bands.find((b) => b.href && t >= b.from - 60 && t <= b.to + 60);
                if (hit) clickRef.current(hit);
              });
            },
          ],
          setCursor: [(u) => updateTip(u, tip, series, bands, theme)],
        },
      };

      plot = new uPlot(opts, [xs, ...series.map((s) => s.values)] as uPlotType.AlignedData, el);
      ro = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height }));
      ro.observe(el);
    });

    return () => {
      disposed = true;
      ro?.disconnect();
      plot?.destroy();
      el.replaceChildren();
    };
  }, [xs, series, range, bands, thresholds, yRange, y2Range, height, theme, clipTop]);

  const summary = summarize(series);

  return (
    <>
      <div ref={host} role="img" aria-label={ariaLabel} className="relative w-full" style={{ minHeight: height }} />
      {clipTop !== null ? <p className="mt-1 text-xs text-muted">Some spikes are taller than the chart. Hover for the value.</p> : null}
      <p className="sr-only">{ariaLabel}. {summary}</p>
    </>
  );
}
