import { expect, type Page } from "@playwright/test";
import { apiPost, createServerApi, type SeededUser } from "./app-helpers";

export interface StatusCfg {
  enabled: boolean;
  slug: string;
  title: string;
  showPlayers: boolean;
  showUptime: boolean;
  showIncidents: boolean;
  theme: "auto" | "dark" | "light";
  hideBranding: boolean;
}
export const cfg = (slug: string, o: Partial<StatusCfg> = {}): StatusCfg => ({
  enabled: true, slug, title: "E2E Status", showPlayers: true, showUptime: true, showIncidents: true, theme: "auto", hideBranding: false, ...o,
});
export const slugOf = (tag = "s") => `e2e-${tag}-${Math.random().toString(36).slice(2, 8)}`;

/** Creates a server for the signed-in page and saves a status page. Returns ids and the agent key. */
export async function serverWithStatus(page: Page, name: string, c: StatusCfg) {
  const s = await createServerApi(page, name);
  const r = await apiPost(page, `/api/servers/${s.server.id}/status-page`, c, "PUT");
  expect(r.status(), await r.text()).toBe(200);
  return { id: s.server.id, key: s.setup.apiKey };
}

export async function noHScroll(page: Page, label: string) {
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  expect.soft(m.sw, `${label}: scrollWidth ${m.sw} > ${m.cw}`).toBeLessThanOrEqual(m.cw);
  expect.soft(m.bw, `${label}: body scrollWidth ${m.bw} > ${m.cw}`).toBeLessThanOrEqual(m.cw);
}

/** Visible interactive elements without an accessible name, plus images without alt, plus a missing h1 / lang / title. */
export async function a11ySmoke(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e);
      return (r.width > 0 || r.height > 0) && st.visibility !== "hidden" && st.display !== "none";
    };
    const nameOf = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return aria;
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) {
        const t = Array.from(labels).map((l) => l.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      const t = (el.textContent ?? "").trim();
      if (t) return t;
      if (el.getAttribute("title")?.trim()) return el.getAttribute("title")!;
      return el.querySelector("img[alt]")?.getAttribute("alt")?.trim() ?? "";
    };
    document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=switch], [role=button]").forEach((e) => {
      if (visible(e) && !nameOf(e as HTMLElement)) out.push(`unnamed ${e.outerHTML.slice(0, 100)}`);
    });
    document.querySelectorAll("img").forEach((i) => {
      if (visible(i) && !i.hasAttribute("alt")) out.push(`img without alt ${i.outerHTML.slice(0, 80)}`);
    });
    if (document.querySelectorAll("h1").length !== 1) out.push(`h1 count ${document.querySelectorAll("h1").length}`);
    if (!document.documentElement.lang) out.push("no html lang");
    if (!document.title.trim()) out.push("no title");
    return out;
  });
}

export const ownerCtxPage = async (browser: import("@playwright/test").Browser, user: SeededUser, contextFor: typeof import("./app-helpers").contextFor, opts = {}) => {
  const ctx = await contextFor(browser, user, opts);
  return { ctx, page: await ctx.newPage() };
};
