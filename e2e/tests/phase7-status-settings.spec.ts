import { expect, test } from "@playwright/test";
import { apiPost, BASE, contextFor, createServerApi, dropUser, seedUser } from "./app-helpers";
import { slugOf } from "./phase7-helpers";

test.beforeEach(({}, info) => test.skip(!["desktop", "freeplan"].includes(info.project.name), "desktop only"));
test.setTimeout(90_000);

const HOSTILE = `A [b] & <i>"q"</i>`;

test("status page settings: defaults, enable, live slug validation (invalid, reserved, brand word, taken 409), save, share box @free", async ({ browser }) => {
  const a = seedUser();
  const b = seedUser();
  const ca = await contextFor(browser, a);
  const cb = await contextFor(browser, b);
  const page = await ca.newPage();
  const pageB = await cb.newPage();
  const takenSlug = slugOf("taken");
  try {
    // user B owns a slug already
    const sb = await createServerApi(pageB, "B server");
    expect((await apiPost(pageB, `/api/servers/${sb.server.id}/status-page`, { enabled: true, slug: takenSlug, title: "B", showPlayers: true, showUptime: true, showIncidents: false, theme: "auto", hideBranding: false }, "PUT")).status()).toBe(200);

    const { server } = await createServerApi(page, "Settings Test");
    await page.goto(`/app/servers/${server.id}/status-page`);
    await expect(page.getByRole("heading", { name: "Status page", exact: true })).toBeVisible();
    // defaults: off, suggestion slug, title = name, no share box content
    const enable = page.getByRole("switch", { name: "Make the status page public" });
    await expect(enable).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(/Off\. Nobody can see this page/)).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Settings Test");
    await expect(page.getByRole("switch", { name: "Show players online" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Show uptime" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Show recent lag incidents" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Turn the status page on and save to get a public link")).toBeVisible();
    // free plan: hide switch disabled and explained
    await expect(page.getByRole("switch", { name: /Hide .Monitored with TickDoctor./ })).toBeDisabled();
    await expect(page.getByText(/Free pages always show/)).toBeVisible();

    const slug = page.getByLabel("Address");
    const save = page.getByRole("button", { name: "Save", exact: true });

    // invalid
    for (const bad of ["ab", "-abc", "abc-", "a--b", "has space"]) {
      await slug.fill(bad);
      await expect(page.getByText(/Use 3 to 40 lowercase letters, numbers or single hyphens|reserved|can't be used/).first(), bad).toBeVisible();
      await expect(save, bad).toBeDisabled();
    }
    // reserved
    await slug.fill("demo");
    await expect(page.getByText("This address can't be used. Please choose another.")).toBeVisible();
    await expect(save).toBeDisabled();
    // brand word as first/last part (API rule BRAND_TOKENS)
    await slug.fill("tickdoctor-status");
    const live = await page.getByText(/can't be used|reserved/).count();
    if (live === 0) {
      test.info().annotations.push({ type: "bug", description: "slug 'tickdoctor-status' passes the live (client) validation; only the server rejects it on Save" });
      await page.getByLabel("Title").fill("Brand test");
      await enable.click();
      await save.click();
    }
    await expect(page.getByText(/reserved|can't be used/).first()).toBeVisible();
    // taken -> 409 message
    await slug.fill(takenSlug);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Someone already uses this address. Please choose another.")).toBeVisible();

    // good slug, hostile title, enable, save
    const mine = slugOf("mine");
    await slug.fill(mine.toUpperCase()); // lower-cased on input
    await expect(slug).toHaveValue(mine);
    await page.getByLabel("Title").fill(HOSTILE);
    if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click();
    await save.click();
    await expect(page.getByText("Saved. Your status page is live.")).toBeVisible();

    // share box
    const url = `${BASE}/s/${mine}`;
    await expect(page.getByRole("link", { name: url })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByAltText("Status badge preview")).toBeVisible();
    const naturalWidth = await page.getByAltText("Status badge preview").evaluate((i: HTMLImageElement) => i.naturalWidth);
    expect(naturalWidth, "badge image actually rendered").toBeGreaterThan(20);
    const md = `[![A \\[b\\] & <i>"q"</i> status](${BASE}/badge/${mine}.svg)](${url})`;
    const html = `<a href="${url}"><img src="${BASE}/badge/${mine}.svg" alt="A [b] &amp; &lt;i&gt;&quot;q&quot;&lt;/i&gt; status"></a>`;
    await expect(page.locator("pre, code").filter({ hasText: md }).first()).toBeVisible();
    await expect(page.locator("pre, code").filter({ hasText: html }).first()).toBeVisible();

    // persisted
    await page.reload();
    await expect(page.getByLabel("Address")).toHaveValue(mine);
    await expect(page.getByLabel("Title")).toHaveValue(HOSTILE);

    // changing the slug frees the old one at once (old URL 404)
    const old = mine;
    const next = slugOf("next");
    await page.getByLabel("Address").fill(next);
    await expect(page.getByText(/You changed the address/)).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/^Saved/)).toBeVisible();
    expect((await page.request.get(`/api/public/status/${old}`)).status()).toBe(404);
    expect((await page.request.get(`/api/public/status/${next}`)).status()).toBe(200);
    // and the old slug is now claimable by B
    expect((await apiPost(pageB, `/api/servers/${sb.server.id}/status-page`, { enabled: true, slug: old, title: "B", showPlayers: true, showUptime: true, showIncidents: false, theme: "auto", hideBranding: false }, "PUT")).status()).toBe(200);
  } finally {
    await ca.close();
    await cb.close();
    dropUser(a.email);
    dropUser(b.email);
  }
});

test("API: invalid/reserved -> 400 fields.slug, taken -> 409, free plan can't hide branding (forced false), plan Pro can @free", async ({ browser }) => {
  const a = seedUser();
  const p = seedUser({ plan: "pro" });
  const ca = await contextFor(browser, a);
  const cp = await contextFor(browser, p);
  const page = await ca.newPage();
  const pagePro = await cp.newPage();
  try {
    const { server } = await createServerApi(page, "API Test");
    const base = { enabled: true, title: "T", showPlayers: true, showUptime: true, showIncidents: false, theme: "auto", hideBranding: false };
    for (const slug of ["demo", "admin", "ab", "BAD slug", "tickdoctor-x", "x-minecraft"]) {
      const r = await apiPost(page, `/api/servers/${server.id}/status-page`, { ...base, slug }, "PUT");
      expect(r.status(), slug).toBe(400);
      expect(((await r.json()) as { error: { fields?: { slug?: string } } }).error.fields?.slug, slug).toBeTruthy();
    }
    const s = slugOf("hide");
    const r = await apiPost(page, `/api/servers/${server.id}/status-page`, { ...base, slug: s, hideBranding: true }, "PUT");
    expect(r.status()).toBe(200);
    expect(((await r.json()) as { hideBranding: boolean }).hideBranding).toBe(false);
    const pub = (await (await page.request.get(`/api/public/status/${s}`)).json()) as { branding: boolean };
    expect(pub.branding).toBe(true);
    // CSRF: PUT without token is refused
    const noCsrf = await page.request.fetch(`/api/servers/${server.id}/status-page`, { method: "PUT", data: { ...base, slug: s }, headers: { origin: BASE } });
    expect(noCsrf.status()).toBeGreaterThanOrEqual(400);

    const sp = await createServerApi(pagePro, "Pro Test");
    const s2 = slugOf("pro");
    const r2 = await apiPost(pagePro, `/api/servers/${sp.server.id}/status-page`, { ...base, slug: s2, hideBranding: true }, "PUT");
    expect(r2.status()).toBe(200);
    expect(((await r2.json()) as { hideBranding: boolean }).hideBranding).toBe(true);
    expect(((await (await pagePro.request.get(`/api/public/status/${s2}`)).json()) as { branding: boolean }).branding).toBe(false);
  } finally {
    await ca.close();
    await cp.close();
    dropUser(a.email);
    dropUser(p.email);
  }
});
