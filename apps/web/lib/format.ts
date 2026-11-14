export const num = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "–" : v.toFixed(digits));

export function bytes(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const severityWord: Record<string, string> = { info: "Info", low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/** The MSPT/TPS tone (matches the API's thresholds: 40 ms degraded, 50 ms = one full tick). */
export function msptTone(v: number | null | undefined): "healthy" | "degraded" | "lagging" | "waiting" {
  if (v === null || v === undefined) return "waiting";
  return v >= 50 ? "lagging" : v >= 40 ? "degraded" : "healthy";
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Ratio (during / usual) in words, rules from content/phase6-copy.md (first match wins). */
export function ratioWords(ratio: number | null, usual?: number | string | null): string {
  if (usual === null) return "no usual to compare";
  if (usual === 0) return "new. Usually none.";
  if (ratio === null || !Number.isFinite(ratio)) return "no usual to compare";
  if (ratio >= 10) return `${ratio.toFixed(0)}× usual`;
  if (ratio >= 1.9 && ratio <= 2.1) return "twice usual";
  if (ratio >= 1.5) return `${ratio.toFixed(1)}× usual`;
  if (ratio >= 1.1) return "a bit above usual";
  if (ratio > 0.9) return "about usual";
  if (ratio > 0.6) return "a bit below usual";
  if (ratio >= 0.4) return "half of usual";
  if (ratio > 0.1) return `${Math.round(ratio * 100)} % of usual`;
  return "almost none";
}
