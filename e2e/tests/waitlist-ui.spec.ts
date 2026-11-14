import { expect, test, type Page } from "@playwright/test";
import { watchErrors } from "./helpers";

async function fill(page: Page, email: string, consent = true) {
  const form = page.locator("form").first();
  await form.getByLabel("Email address").fill(email);
  if (consent) await form.getByRole("checkbox").check();
  return form;
}
const submit = (form: ReturnType<Page["locator"]>) => form.getByRole("button", { name: /Join the waitlist/ }).click();

test("success: focus moves to status, request body is right", async ({ page }) => {
  let body: any;
  await page.route("**/api/waitlist", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/");
  const form = await fill(page, "a@example.com");
  await submit(form);
  const status = page.locator('[role="status"][tabindex="-1"]');
  await expect(status).toContainText("You're on the list.");
  await expect(status).toBeFocused();
  expect(body).toMatchObject({ email: "a@example.com", source: "landing-hero", consent: true, website: "" });
});

test("client-side: invalid email and missing consent make no request", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/waitlist", (r) => {
    calls++;
    return r.fulfill({ status: 200, body: '{"ok":true}' });
  });
  await page.goto("/");
  const form = page.locator("form").first();
  await form.getByLabel("Email address").fill("not-an-email");
  await form.getByRole("checkbox").check();
  await submit(form);
  await expect(form).toContainText("That doesn't look like an email address. Could you check it?");
  await expect(form.getByLabel("Email address")).toBeFocused();
  await expect(form.getByLabel("Email address")).toHaveAttribute("aria-invalid", "true");

  await form.getByLabel("Email address").fill("ok@example.com");
  await form.getByRole("checkbox").uncheck();
  await submit(form);
  await expect(form).toContainText("Please tick the box so we know it's OK to email you.");
  await expect(form.getByRole("checkbox")).toBeFocused();
  expect(calls).toBe(0);
});

const serverCases: [string, number, any, string][] = [
  ["invalid_email", 400, { error: { code: "invalid_email" } }, "That doesn't look like an email address. Could you check it?"],
  ["consent_required", 400, { error: { code: "consent_required" } }, "Please tick the box so we know it's OK to email you."],
  ["rate_limited", 429, { error: { code: "rate_limited" } }, "Too many tries from your connection. Please wait a minute and try again."],
  ["generic 500", 500, { error: { code: "internal" } }, "Something went wrong on our side. Please try again in a moment."],
];
for (const [name, status, json, msg] of serverCases) {
  test(`server error: ${name}`, async ({ page }) => {
    await page.route("**/api/waitlist", (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }));
    await page.goto("/");
    const form = await fill(page, "a@example.com");
    await submit(form);
    await expect(form).toContainText(msg);
    // form stays usable
    await expect(form.getByRole("button", { name: "Join the waitlist" })).toBeEnabled();
  });
}

test("network failure shows generic error", async ({ page }) => {
  await page.route("**/api/waitlist", (r) => r.abort());
  await page.goto("/");
  const form = await fill(page, "a@example.com");
  await submit(form);
  await expect(form).toContainText("Something went wrong on our side.");
});

test("honeypot is not focusable nor visible", async ({ page }) => {
  await page.goto("/");
  const hp = page.locator('form').first().locator('input[name="hp_field"]');
  await expect(hp).toHaveAttribute("tabindex", "-1");
  const box = await hp.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box === null || box.x + box.width <= 0 || box.x >= vw).toBe(true);
  // tabbing through the whole form never lands on it
  const email = page.locator("form").first().getByLabel("Email address");
  await email.focus();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).not.toBe("hp_field");
  }
  // no horizontal overflow caused by it
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("REAL end-to-end submission is stored in Postgres", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one real submission per run");
  const { psqlCount, restartApi, waitApiHealthy } = await import("./helpers");
  const email = `qa+${Date.now()}@example.com`;
  const errors = watchErrors(page);

  async function attempt() {
    await page.goto("/");
    const form = await fill(page, email);
    const [resp] = await Promise.all([page.waitForResponse("**/api/waitlist"), submit(form)]);
    return resp.status();
  }
  let s = await attempt();
  if (s === 429) {
    restartApi();
    await waitApiHealthy("http://localhost:3000");
    s = await attempt();
  }
  expect(s).toBe(200);
  await expect(page.locator('[role="status"][tabindex="-1"]')).toContainText("You're on the list.");
  expect(psqlCount(email)).toBe(1);
  expect(errors.filter((e) => !/429/.test(e))).toEqual([]);
});
