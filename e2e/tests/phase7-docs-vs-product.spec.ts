import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentPost, dropUser, helloBody, metricsBody, mailLink, PASSWORD, repo, sql, uniqueEmail } from "./app-helpers";
import { randomUUID } from "node:crypto";

// Walks /docs/install with a real browser and compares every app-side instruction with the real UI. No Minecraft server: the
// server-side steps (3, 5, 6 console part) can't be walked, so a fake agent pushes hello + metrics with the snippet's key instead.
const note = (a: { type: string; description: string }) => { console.log(`NOTE ${a.type}: ${a.description}`); test.info().annotations.push(a); };
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));
test.setTimeout(120_000);

const docSrc = readFileSync(join(repo, "apps/web/content/docs/install.md"), "utf8");

test("docs/install app-side steps match the real UI; the snippet's key makes the panel turn green", async ({ page, request }) => {
  const email = uniqueEmail("docs");
  try {
    // The docs page itself renders the quoted UI labels
    await page.goto("/docs/install");
    const doc = await page.locator("main").innerText();
    for (const s of ["Sign up", "Continue", "Add a server", "API key", "td_live_", "Download plugin", "tickdoctor-agent-", "Copy snippet", "Waiting for first data", "Your server is talking to TickDoctor.", "Open the dashboard"])
      expect(doc, `docs mention "${s}"`).toContain(s);

    // Step 1.1: "Open the app and choose Sign up."
    await page.goto("/");
    await page.waitForTimeout(3000);
    const signupLinks = await page.getByRole("link", { name: /sign up/i }).count();
    note({ type: "mismatch", description: `landing page has ${signupLinks} link(s) named "Sign up" (docs: "choose Sign up")` });
    await page.getByRole("link", { name: "Log in" }).first().click();
    const create = await page.getByRole("link", { name: /sign up|create (an )?account|get started/i }).allInnerTexts();
    note({ type: "login-page links", description: create.join(" | ") });
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/signup/);
    // "Enter your email address. We send you a link; the account only exists once you open it."
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    expect(sql(`select count(*) from users where email='${email}' and email_verified_at is not null`), "no confirmed account before the link").toBe("0");

    // 1.2: "Open the link, press Continue, and choose a password. A name is optional. Ticking the consent box ..."
    const link = await mailLink(email, "Confirm your email");
    await page.goto(link);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel(/name/i).first()).toBeVisible();
    const nameField = page.getByLabel(/^(Your )?name/i);
    expect(await nameField.count(), "an optional name field exists on the password step").toBeGreaterThan(0);
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("New password again").fill(PASSWORD);
    await page.getByRole("checkbox", { name: /I agree/ }).check();
    console.log("CONSENT LABEL:", await page.getByRole("checkbox", { name: /I agree/ }).evaluate((e) => (e as HTMLInputElement).labels?.[0]?.textContent));
    await page.getByRole("button", { name: "Save password and log in" }).click();

    // 1.3: "You land on Add a server."
    await page.waitForURL(/\/app/);
    const landedOnboarding = /\/app\/onboarding/.test(page.url());
    note({ type: "landing", description: page.url() });
    if (!landedOnboarding) await page.goto("/app/onboarding");
    await expect(page.getByRole("heading", { name: "Add a server", level: 1 })).toBeVisible();
    // "Give the server a name (only you see it; you can change it later) and continue."
    await expect(page.getByText("Only you see this. You can change it later.")).toBeVisible();
    await page.getByLabel("Server name").fill("Docs Walk");
    const btn = page.getByRole("button", { name: /Create server|Continue/ });
    note({ type: "button", description: `wizard step 1 button = "${await btn.innerText()}" (docs say: "and continue")` });
    await btn.click();

    // 1.4: "API key and config snippet. The key starts with td_live_ and is shown only once."
    await expect(page.getByText("Copy your API key now")).toBeVisible();
    const key = (await page.getByLabel("Your API key").innerText()).trim();
    expect(key).toMatch(/^td_live_[A-Za-z0-9]{20,}$/);
    await expect(page.getByText("This is the only time we show it.")).toBeVisible();
    await expect(page.getByText(/make a new one in the server's settings/)).toBeVisible();
    // Step 2: "press Download plugin. You get a file named tickdoctor-agent-<version>.jar"
    const dl = page.getByRole("link", { name: /^Download plugin/ });
    await expect(dl).toBeVisible();
    // An <a download> that gets an error response (404/502 while the jar dir is rebuilt) is still saved, named after the URL ("latest.jar").
    // Fail with the real cause instead of a confusing filename mismatch.
    const probe = await page.request.head("/downloads/agent/latest.jar");
    expect(probe.status(), "agent jar endpoint (is agent/build/libs empty or the bind mount stale after a gradle clean?)").toBe(200);
    const [download] = await Promise.all([page.waitForEvent("download"), dl.click()]);
    expect(download.suggestedFilename()).toMatch(/^tickdoctor-agent-\d+\.\d+\.\d+\.jar$/);
    // Step 4: snippet keys, order, quoting: api-url then api-key, both double-quoted
    await expect(page.getByRole("button", { name: "Copy snippet" })).toBeVisible();
    const snippet = (await page.getByLabel("config.yml").innerText()).trim();
    const lines = snippet.split("\n").map((l) => l.trim()).filter(Boolean);
    note({ type: "snippet", description: snippet.replace(key, "td_live_<redacted>") });
    expect(lines.map((l) => l.split(":")[0]), "snippet keys in order").toEqual(["api-url", "api-key"]);
    expect(lines[0]).toMatch(/^api-url: "https?:\/\/[^"]+"$/);
    expect(lines[1]).toBe(`api-key: "${key}"`);
    expect(docSrc).toContain('api-url: "https://<address shown in your snippet>"');
    expect(docSrc).toContain('api-key: "td_live_<your key>"');
    // App's own step 3 text matches Step 5 of the docs
    await expect(page.getByText("Restart the server.", { exact: true })).toBeVisible();
    await expect(page.getByText(/Not \/reload/)).toBeVisible();

    // "Waiting for first data…" panel, "(You can leave the page too: ... same waiting state.)"
    await expect(page.getByText("Waiting for first data…")).toBeVisible();
    await expect(page.getByText(/You can leave this page\. Your server stays in your list, and its dashboard shows the same waiting state\./)).toBeVisible();

    // Fake agent with the snippet's key: hello + metrics => the panel turns green by itself
    const boot = randomUUID();
    expect((await agentPost(request, key, "hello", helloBody(boot))).status()).toBeLessThan(300);
    expect((await agentPost(request, key, "metrics", metricsBody({ players: 2 }, boot))).status()).toBeLessThan(300);
    await expect(page.getByText("Your server is talking to TickDoctor.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page.waitForTimeout(6000);
    const panel = await page.getByRole("status").filter({ hasText: "Your server is talking to TickDoctor." }).innerText();
    note({ type: "green panel", description: panel.replace(/\n+/g, " | ") });
    expect.soft(panel, "BUG docs/install: \"It also shows your server software and the plugin version.\"").toMatch(/Paper|Purpur|Spigot/);
    expect.soft(panel).toMatch(/plugin v\d/);
    await expect(page.getByRole("link", { name: "Open the dashboard" })).toBeVisible();
    await page.getByRole("link", { name: "Open the dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Docs Walk", level: 1 })).toBeVisible();

    // A wrong key is rejected the way troubleshooting says (invalid key -> 401)
    const wrong = await agentPost(request, key.slice(0, -2) + "xx", "hello", helloBody());
    expect(wrong.status()).toBe(401);
  } finally {
    dropUser(email);
  }
});
