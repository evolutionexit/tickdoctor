import { test, expect } from "@playwright/test";
import { safeLink } from "../../apps/web/lib/safe-link";
import { own } from "../../apps/web/lib/own";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

test.describe("markdown link allow-list (audit L1)", () => {
  for (const bad of ["/\\evil.com", "//evil.com", "/\\\\evil.com", "/a\\b", "https://evil.example/fix", "http://discord.com/x", "javascript:alert(1)", "https://discord.com.evil.example/", "https://user@discord.com/", "https://discord.com:8443/", "", "relative/path"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(safeLink(bad)).toBeNull());
  }
  test("allows app paths and allow-listed https hosts", () => {
    expect(safeLink("/docs/findings/x")).toEqual({ kind: "internal", href: "/docs/findings/x" });
    expect(safeLink("https://docs.papermc.io/paper")?.kind).toBe("external");
    expect(safeLink("https://spark.lucko.me/")?.kind).toBe("external");
    expect(safeLink("https://discord.com/invite/abc")?.kind).toBe("external");
  });
});

test("own() ignores prototype keys (audit INFO)", () => {
  expect(own({ a: 1 }, "a")).toBe(1);
  for (const k of ["__proto__", "constructor", "toString"]) expect(own({ a: 1 }, k)).toBeUndefined();
});

test("/og/__proto__ is a 404, not a 500", async ({ request, baseURL }) => {
  for (const k of ["__proto__", "constructor", "legal/__proto__"]) {
    const r = await request.get(`${baseURL}/og/${k}`);
    expect(r.status()).toBe(404);
  }
});

// Pentest F-06/F-01: isolation headers on pages; badges, OG images, downloads and public status JSON stay embeddable.
test("page responses carry COOP + CORP same-origin + X-Permitted-Cross-Domain-Policies, and no COEP", async ({ request, baseURL }) => {
  for (const path of ["/", "/login", "/docs", "/health"]) {
    const h = (await request.get(`${baseURL}${path}`)).headers();
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(h["cross-origin-resource-policy"], path).toBe("same-origin");
    expect(h["x-permitted-cross-domain-policies"], path).toBe("none");
    expect(h["cross-origin-embedder-policy"], path).toBeUndefined();
  }
});

test("badges, OG images, downloads and public status JSON stay cross-origin embeddable", async ({ request, baseURL }) => {
  for (const path of ["/badge/nope.svg", "/s/nope/opengraph-image", "/og/__proto__", "/downloads/nope", "/api/public/status/nope"]) {
    const h = (await request.get(`${baseURL}${path}`)).headers();
    expect(h["cross-origin-resource-policy"], path).toBe("cross-origin");
  }
});

// ZAP follow-up 2026-11-14: a <form> without method submits as GET, so a submit before hydration / with JS off would put the
// email + password into the URL. Every JS-handled form must declare method="post" (only the findings filter stays GET).
test("every form with a submit handler declares method=post (no credentials in the URL)", () => {
  const root = join(process.cwd(), "../apps/web/components");
  const files: string[] = [];
  const walk = (d: string) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") && files.push(p); });
  walk(root);
  const bad: string[] = [];
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/<form\b[^\n]*/g)) if (!/method="post"/.test(m[0]) && !/aria-label="Filter findings"/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 60)}`);
  expect(bad).toEqual([]);
});
