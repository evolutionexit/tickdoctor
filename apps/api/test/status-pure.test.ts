import { describe, expect, it } from "vitest";
import { brand } from "@tickdoctor/shared";
import { escapeXml, renderBadge, statusBadge, textColorOn, textWidth, unknownBadge } from "../src/status-pages/badge.js";
import { computeUptime, publicState } from "../src/status-pages/public.js";
import { slugBase, slugProblem } from "../src/status-pages/settings.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("computeUptime", () => {
  const start = Date.parse("2026-11-10T10:30:00Z");

  it("null below 60 minutes of window", () => {
    expect(computeUptime(start, start + 59 * MIN, [])).toBeNull();
    expect(computeUptime(start, start + 60 * MIN, [])).toBe(0);
  });

  it("counts 1-min buckets; partial hours at the window edges", () => {
    const hours = [
      { hourMs: start - 30 * MIN, minutes: 30, hourSamples: null }, // 10:00 hour, only 10:30–11:00 in the window
      { hourMs: start + 30 * MIN, minutes: 30, hourSamples: null }, // 11:00 hour: half
    ];
    expect(computeUptime(start, start + 90 * MIN, hours)).toBe(66.7);
  });

  it("1-h estimate = samples / 6, capped at 60, scaled to the part inside the window; max with the 1-min count", () => {
    const h0 = start - 30 * MIN;
    // 360 samples = a full hour, only half of it inside the window → 30 minutes.
    expect(computeUptime(start, start + 30 * MIN + HOUR, [{ hourMs: h0, minutes: 0, hourSamples: 360 }, { hourMs: h0 + HOUR, minutes: 0, hourSamples: 99_999 }])).toBe(100);
    // Pruned 1-min rows at a retention boundary: estimate (45 min) beats the 10 remaining 1-min rows.
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 10, hourSamples: 270 }])).toBe(75);
    // 1-min rows win when larger (irregular sampling).
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 50, hourSamples: 60 }])).toBe(83.3);
    // Never above 100.
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 61, hourSamples: 9999 }])).toBe(100);
  });

  it("M1: interval-aware — 30 s and 300 s agents", () => {
    const h0 = start - 30 * MIN;
    // 30 s: 120 samples fill an hour (would be 33 % at 10 s).
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 0, hourSamples: 120 }], 30)).toBe(100);
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 0, hourSamples: 120 }], 10)).toBe(33.3);
    // 300 s: one 1-min row every 5 minutes = 12 rows, or 12 samples, fill the hour.
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 12, hourSamples: null }], 300)).toBe(100);
    expect(computeUptime(h0, h0 + HOUR, [{ hourMs: h0, minutes: 0, hourSamples: 6 }], 300)).toBe(50);
  });

  it("the hour where data begins is not scaled down (its 1-h row only holds samples after the first one)", () => {
    const h0 = start - 30 * MIN; // data starts at :30
    // 30 minutes of samples in the first hour + a full next hour: fully up.
    const hours = [{ hourMs: h0, minutes: 0, hourSamples: 180 }, { hourMs: h0 + HOUR, minutes: 0, hourSamples: 360 }];
    expect(computeUptime(start, h0 + 2 * HOUR, hours, 10, start)).toBe(100);
    // Without knowing where data begins, the same row would be scaled (window start, not data start).
    expect(computeUptime(start, h0 + 2 * HOUR, hours, 10)).toBe(83.3);
  });

  it("hours outside the window are ignored", () => {
    expect(computeUptime(start, start + HOUR, [{ hourMs: start - 5 * HOUR, minutes: 60, hourSamples: 360 }])).toBe(0);
  });
});

describe("publicState", () => {
  it("maps the health states", () => {
    expect(["healthy", "degraded", "lagging", "offline", "waiting"].map((h) => publicState(h as never))).toEqual(["operational", "degraded", "lagging", "offline", "offline"]);
  });
});

describe("badge", () => {
  it("escapes XML", () => {
    expect(escapeXml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&apos;");
    expect(escapeXml("a\u202Eb\u0000c\u2069")).toBe("abc");
  });

  it("width grows with text; wide letters count more", () => {
    expect(textWidth("online · 12 players")).toBeGreaterThan(textWidth("online"));
    expect(textWidth("mmmm")).toBeGreaterThan(textWidth("iiii"));
    const svg = renderBadge({ label: "minecraft", message: "online", color: "#3b82f6", title: "t" });
    const w = Number(/width="(\d+(?:\.\d+)?)"/.exec(svg)![1]);
    expect(w).toBe(textWidth("minecraft") + textWidth("online") + 24);
  });

  it("uses the brand health colours, readable text colour, word always present", () => {
    for (const [state, color] of [["operational", brand.colors.health.healthy], ["degraded", brand.colors.health.degraded], ["lagging", brand.colors.health.lagging], ["offline", brand.colors.health.offline]] as const) {
      const svg = statusBadge({ title: "T", state, players: { online: 1, max: 8 }, branding: true });
      expect(svg).toContain(`fill="${color}"`);
      expect(svg).toMatch(state === "offline" ? />offline</ : state === "operational" ? />online · 1 player</ : new RegExp(`>${state} · 1 player<`));
      expect(svg).toContain(`Monitored with ${brand.name}`);
    }
    expect(textColorOn(brand.colors.health.degraded)).toBe("#111318");
    expect(textColorOn("#3a414d")).toBe("#ffffff");
    expect(statusBadge({ title: "T", state: "operational", players: null, branding: false })).not.toContain("Monitored");
  });

  it("unknown badge: grey, self-contained", () => {
    const svg = unknownBadge();
    expect(svg).toContain(">unknown<");
    expect(svg).toContain(brand.colors.health.offline);
    expect(svg).not.toMatch(/href|<script|<image|<foreignObject/);
  });
});

describe("slug helpers", () => {
  it("slugProblem", () => {
    expect(slugProblem("good-slug-1")).toBeNull();
    expect(slugProblem("support")).toMatch(/reserved/);
    expect(slugProblem("a--b")).toMatch(/3–40/);
    expect(slugProblem("tickdoctor-fans")).toMatch(/reserved/);
    expect(slugProblem("fans-of-mojang")).toMatch(/reserved/);
    expect(slugProblem("fans-of-mojang-stuff")).toBeNull();
  });
  it("slugBase gives a valid, non-reserved slug", () => {
    expect(slugBase("Creeper Hollow SMP")).toBe("creeper-hollow-smp");
    expect(slugBase("Docs")).toBe("docs-server");
    expect(slugBase("!!")).toBe("server");
    expect(slugBase("Ab")).toBe("ab-server");
    expect(slugProblem(slugBase("x".repeat(80)))).toBeNull();
  });
});
