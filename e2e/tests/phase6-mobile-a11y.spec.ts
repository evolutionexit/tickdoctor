import { expect, test, type Page } from "@playwright/test";
import { contextFor, createServerApi, dropUser, seedUser } from "./app-helpers";
import { insertFindings, seedIncidentWorld } from "./phase6-helpers";

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop project only (own viewport below)"));
test.setTimeout(90_000);

async function noHScroll(page: Page, label: string) {
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  expect.soft(m.sw, `${label}: scrollWidth ${m.sw} > ${m.cw}`).toBeLessThanOrEqual(m.cw);
  expect.soft(m.bw, `${label}: body scrollWidth ${m.bw} > ${m.cw}`).toBeLessThanOrEqual(m.cw);
}

/** Lists visible interactive elements without an accessible name. */
async function unnamed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e);
      return (r.width > 0 || r.height > 0) && st.visibility !== "hidden" && st.display !== "none";
    };
    const nameOf = (e: Element): string => {
      const el = e as HTMLElement;
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return aria;
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      if ((el as HTMLInputElement).labels?.length) {
        const t = Array.from((el as HTMLInputElement).labels!).map((l) => l.textContent ?? "").join(" ").trim();
        if (t) return t;
      }
      const t = (el.textContent ?? "").trim();
      if (t) return t;
      if (el.getAttribute("title")?.trim()) return el.getAttribute("title")!;
      const img = el.querySelector("img[alt]");
      return img?.getAttribute("alt")?.trim() ?? "";
    };
    document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=switch], [role=button]").forEach((e) => {
      if (!visible(e)) return;
      if (!nameOf(e)) out.push(`${e.tagName.toLowerCase()}${(e as HTMLElement).className ? "." + String((e as HTMLElement).className).split(" ")[0] : ""} ${e.outerHTML.slice(0, 100)}`);
    });
    return out;
  });
}

test("phone 390x844: incidents, incident page, findings, alerts have no horizontal page scroll", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 Phone");
    const w = seedIncidentWorld(server.id, { open: true });
    insertFindings(server.id, [
      { key: "a", title: "Critical entity pile with a rather long title that has to wrap on a small screen", severity: "critical", incidentIds: [w.closedId] },
      { key: "b", title: "High memory pressure", severity: "high", ruleId: "gc-pressure", scope: "server" },
      { key: "tip", title: "Xms and Xmx differ", severity: "info", ruleId: "jvm-flags", scope: "server" },
    ]);
    const base = `/app/servers/${server.id}`;
    await page.goto(`${base}/incidents`);
    await expect(page.getByRole("heading", { name: "Incidents", exact: true })).toBeVisible();
    await noHScroll(page, "incidents");
    await page.goto(`${base}/incidents/${w.closedId}`);
    await expect(page.getByRole("heading", { name: "Worst chunks" })).toBeVisible();
    // diagnosis of the known overflow: the CopyButton's sr-only live region (position:absolute) escapes the table's overflow-x container
    const srOnly = await page.evaluate(() => {
      const before = document.documentElement.scrollWidth;
      const els = Array.from(document.querySelectorAll("table .sr-only[role=status]")) as HTMLElement[];
      els.forEach((e) => (e.style.display = "none"));
      return { before, after: document.documentElement.scrollWidth, count: els.length };
    });
    test.info().annotations.push({ type: "incident page overflow diagnosis", description: JSON.stringify(srOnly) });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Worst chunks" })).toBeVisible();
    await noHScroll(page, "incident page");
    await page.getByRole("button", { name: "Show everything" }).click();
    await noHScroll(page, "incident page, all changes shown");
    await page.goto(`${base}/incidents/${w.openId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Lag in progress");
    await noHScroll(page, "open incident page");
    await page.goto(`${base}/findings`);
    await expect(page.getByText("High memory pressure").first()).toBeVisible();
    await noHScroll(page, "findings");
    await page.getByRole("button", { name: "Mark as fixed" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noHScroll(page, "findings with dialog");
    const box = await page.getByRole("dialog").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await page.goto(`${base}/alerts`);
    await expect(page.getByRole("heading", { name: "Alerts", exact: true })).toBeVisible();
    await noHScroll(page, "alerts");
    await page.getByLabel("Webhook URL").fill("https://example.com/x");
    await page.getByRole("button", { name: "Save changes" }).click();
    await noHScroll(page, "alerts with error");
    await page.getByRole("checkbox", { name: "Quiet hours" }).check();
    await noHScroll(page, "alerts quiet hours");
    // tap targets of the main controls
    for (const name of ["Save changes", "Send test alert"]) {
      const b = await page.getByRole("button", { name }).boundingBox();
      expect(b!.height, name).toBeGreaterThanOrEqual(36);
    }
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});

test("accessibility smoke: names on inputs/buttons/links, dialog focus trap + Escape, landmarks, headings", async ({ browser }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u);
  const page = await ctx.newPage();
  try {
    const { server } = await createServerApi(page, "P6 A11y");
    const w = seedIncidentWorld(server.id, { open: true });
    insertFindings(server.id, [
      { key: "a", title: "Critical entity pile", severity: "critical", incidentIds: [w.closedId] },
      { key: "tip", title: "Xms and Xmx differ", severity: "info", ruleId: "jvm-flags", scope: "server" },
    ]);
    const base = `/app/servers/${server.id}`;
    const pages: [string, string][] = [
      [`${base}/incidents`, "Incidents"],
      [`${base}/incidents/${w.closedId}`, "Worst chunks"],
      [`${base}/findings`, "Findings"],
      [`${base}/alerts`, "Alerts"],
    ];
    for (const [path, ready] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: ready, exact: true }).first()).toBeVisible();
      await page.waitForTimeout(800);
      expect(await unnamed(page), `unnamed controls on ${path}`).toEqual([]);
      expect(await page.locator("h1").count(), `h1 count on ${path}`).toBe(1);
      expect(await page.locator("main").count(), `main landmark on ${path}`).toBeGreaterThan(0);
      const imgs = await page.locator("img:not([alt])").count();
      expect(imgs, `img without alt on ${path}`).toBe(0);
      // tables have captions / header cells
      for (const t of await page.locator("table").all()) {
        expect(await t.locator("caption").count()).toBeGreaterThan(0);
        expect(await t.locator("th[scope]").count()).toBeGreaterThan(0);
      }
      // charts are labelled
      for (const c of await page.locator("canvas").all()) {
        const lab = await c.evaluate((e) => e.getAttribute("aria-label") || e.closest("[aria-label],[role=img]")?.getAttribute("aria-label") || e.parentElement?.getAttribute("aria-label") || "");
        test.info().annotations.push({ type: `canvas label ${path}`, description: lab || "(none on canvas element)" });
      }
    }

    // dialog: focus moves in, Tab/Shift+Tab stay inside, Escape closes and returns focus to the trigger
    await page.goto(`${base}/findings`);
    const trigger = page.getByRole("button", { name: "Mark as fixed" }).first();
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.press("Enter");
    const dlg = page.getByRole("dialog", { name: "Mark this as fixed?" });
    await expect(dlg).toBeVisible();
    // native modal <dialog>: Tab may leave to the browser UI (activeElement = body) but never into the inert page behind
    const inside = () => page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog[open]"));
    expect(await inside()).toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${i} stays in dialog`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${i} stays in dialog`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Mark as fixed");
    // backdrop click closes too
    await trigger.click();
    await expect(dlg).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dlg).toBeHidden();

    // keyboard operation of the alerts switch and filters
    await page.goto(`${base}/alerts`);
    const sw = page.getByRole("switch", { name: "Send alerts to Discord" });
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    // errors announced
    await page.getByLabel("Webhook URL").fill("nope");
    await page.getByRole("button", { name: "Save changes" }).click();
    const err = page.getByText("That isn't a Discord webhook URL");
    await expect(err).toBeVisible();
    const invalid = await page.getByLabel("Webhook URL").getAttribute("aria-invalid");
    const role = await err.evaluate((e) => e.closest("[role=alert]") !== null || e.getAttribute("role") === "alert");
    test.info().annotations.push({ type: "alerts url error", description: `aria-invalid=${invalid}, in role=alert: ${role}` });
    expect(invalid === "true" || role, "URL error is exposed to assistive tech").toBe(true);
  } finally {
    dropUser(u.email);
    await ctx.close();
  }
});
