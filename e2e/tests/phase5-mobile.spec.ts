import { expect, test, type Page } from "@playwright/test";
import { agentPost, contextFor, createServerApi, dropUser, helloBody, mailLink, metricsBody, seedUser, uniqueEmail } from "./app-helpers";

// Phone viewport 390x844 pinned explicitly so the result doesn't depend on the project; runs once (desktop project).
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "one run is enough"));

const noHScroll = async (p: Page, label: string) => {
  const over = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(over.sw, `${label}: scrollWidth ${over.sw} > viewport ${over.cw}`).toBeLessThanOrEqual(over.cw);
};

test("phone: signup, verify page and password step have no horizontal scroll", async ({ page }) => {
  await page.goto("/signup");
  await noHScroll(page, "/signup");
  await page.goto("/login");
  await noHScroll(page, "/login");
  const email = uniqueEmail("phone");
  try {
    await page.goto("/signup");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await noHScroll(page, "check your email");
    await page.goto(await mailLink(email, "Confirm your email"));
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await noHScroll(page, "/verify-email ready");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    await page.getByRole("button", { name: "Save password and log in" }).click(); // error state widens nothing
    await noHScroll(page, "/verify-email password step with errors");
    await page.goto("/verify-email?token=bogus");
    await expect(page.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
    await noHScroll(page, "/verify-email failed");
  } finally {
    dropUser(email);
  }
});

test("phone: /app, onboarding, dashboard, settings, account have no horizontal scroll", async ({ browser, request }) => {
  const u = seedUser();
  const ctx = await contextFor(browser, u, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Your servers" })).toBeVisible();
    await noHScroll(page, "/app (empty)");
    await page.goto("/app/onboarding");
    await page.getByLabel("Server name").fill("A very long server name that should wrap nicely on a phone screen ok");
    await page.getByRole("button", { name: "Create server" }).click();
    await expect(page.getByText("Copy your API key now")).toBeVisible();
    await noHScroll(page, "/app/onboarding (key + snippet)");
    const key = (await page.getByLabel("Your API key").innerText()).trim();
    const id = (await (await page.request.get("/api/servers")).json()).servers[0].id as string;
    await page.goto(`/app/servers/${id}`);
    await expect(page.getByText("Waiting for first data…")).toBeVisible();
    await noHScroll(page, "dashboard waiting");
    await agentPost(request, key, "hello", helloBody("b3333333-3333-4333-8333-333333333333"));
    await agentPost(request, key, "metrics", metricsBody({}, "b3333333-3333-4333-8333-333333333333"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Host machine" })).toBeVisible();
    await page.waitForTimeout(800);
    await noHScroll(page, "dashboard with data");
    await page.goto("/app");
    await expect(page.getByRole("link", { name: /A very long server name/ })).toBeVisible();
    await noHScroll(page, "/app (one server)");
    await page.goto(`/app/servers/${id}/settings`);
    await noHScroll(page, "settings");
    await page.goto("/app/account");
    await noHScroll(page, "account");
  } finally {
    await ctx.close();
    dropUser(u.email);
  }
});
void createServerApi;
