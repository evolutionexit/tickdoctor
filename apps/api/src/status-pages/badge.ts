import { brand, type PublicStatus } from "@tickdoctor/shared";

// GET /badge/:slug.svg (contract app-phase7.ts): a shields-style flat badge. Self-contained (no external refs,
// no fonts to fetch, no scripts); every piece of text is XML-escaped.

/** Escapes XML and drops control / bidi characters (defensive: titles are already cleaned on save). */
export function escapeXml(s: string): string {
  return s.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const NARROW = new Set([..."iIl.,:;!|'`·()[]{} jft1"]);
const WIDE = new Set([..."mwMW@%"]);

/** Approximate rendered width of `text` at 11 px Verdana/DejaVu Sans (good enough for a badge). */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += NARROW.has(ch) ? 3.6 : WIDE.has(ch) ? 10 : /[A-Z0-9]/.test(ch) ? 7.4 : 6.6;
  return Math.ceil(w);
}

const STATE_WORD: Record<PublicStatus["state"], string> = {
  operational: "online",
  degraded: "degraded",
  lagging: "lagging",
  offline: "offline",
};

const STATE_COLOR: Record<PublicStatus["state"], string> = {
  operational: brand.colors.health.healthy,
  degraded: brand.colors.health.degraded,
  lagging: brand.colors.health.lagging,
  offline: brand.colors.health.offline,
};

/** Text colour for a background: whichever of white / near-black has the higher contrast. */
export function textColorOn(hex: string): string {
  const v = hex.replace("#", "");
  const lin = (i: number) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  const vsWhite = 1.05 / (L + 0.05);
  const vsDark = (L + 0.05) / (0.0137 + 0.05); // #111318
  return vsWhite >= vsDark ? "#ffffff" : "#111318";
}

export interface BadgeInput {
  label: string;
  message: string;
  color: string;
  /** Accessible name / tooltip. */
  title: string;
}

export function renderBadge(b: BadgeInput): string {
  const pad = 6;
  const lw = textWidth(b.label) + pad * 2;
  const mw = textWidth(b.message) + pad * 2;
  const w = lw + mw;
  const label = escapeXml(b.label);
  const message = escapeXml(b.message);
  const title = escapeXml(b.title);
  const leftBg = "#3a414d";
  const fg = textColorOn(b.color);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="${leftBg}"/><rect x="${lw}" width="${mw}" height="20" fill="${b.color}"/></g>` +
    `<g text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="14" fill="#ffffff">${label}</text>` +
    `<text x="${lw + mw / 2}" y="14" fill="${fg}">${message}</text>` +
    `</g></svg>`
  );
}

/** Badge for a public status: "minecraft | online · 12 players" (players only when shown and not offline). */
export function statusBadge(s: Pick<PublicStatus, "title" | "state" | "players" | "branding">): string {
  let message = STATE_WORD[s.state];
  if (s.players && s.state !== "offline") message += ` · ${s.players.online} ${s.players.online === 1 ? "player" : "players"}`;
  const title = `${s.title}: ${message}${s.branding ? ` · Monitored with ${brand.name}` : ""}`;
  return renderBadge({ label: "minecraft", message, color: STATE_COLOR[s.state], title });
}

/** The 404 badge: identical for unknown and disabled slugs. */
export function unknownBadge(): string {
  return renderBadge({ label: "minecraft", message: "unknown", color: brand.colors.health.offline, title: "minecraft: unknown" });
}
