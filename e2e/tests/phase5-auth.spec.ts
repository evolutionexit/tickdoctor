import { expect, test, type Browser, type Page } from "@playwright/test";
import { apiPost, BASE, contextFor, dropUser, mailCount, mailLink, PASSWORD, seedUser, sql, uiLogin, uniqueEmail, waitForMail } from "./app-helpers";

// Phase 5 auth: the "confirm first, choose a password after" model. Desktop only (rate limits are per IP and in memory: signup 10/h,
// email sends 3 per address per 15 min, logins 20/15 min), so every test uses its own address and as few UI signups as possible.
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "desktop only"));

const GENERIC = /That email and password don't match/;
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
const consentBox = (p: Page) => p.getByRole("checkbox", { name: /I agree/ });
const cookieNames = async (p: Page) => (await p.context().cookies(BASE)).map((c) => c.name);

async function uiSignup(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

test("signup: email + consent only, confirm link, password step with inline errors, name saved", async ({ page }) => {
  const email = uniqueEmail("signup");
  const notFound: string[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 404) notFound.push(`${r.status()} ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  try {
    await page.goto("/signup");
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByLabel(/name/i)).toHaveCount(0);
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    // no consent checkbox on /signup: a sentence + privacy link instead
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByText("We'll email you a link to finish creating your account")).toBeVisible();
    await expect(page.locator("#main").getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", "/legal/privacy");
    const signupReq = page.waitForRequest((r) => r.url().endsWith("/api/auth/signup") && r.method() === "POST");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Create account" }).click();
    expect(Object.keys((await signupReq).postDataJSON() as object)).toEqual(["email"]);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    expect(await cookieNames(page)).not.toContain("td_session");

    const link = await mailLink(email, "Confirm your email");
    const token = tokenOf(link);
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
    // reading the page must not consume the token
    expect((await page.request.get(`/api/auth/verify-token?token=${token}`)).status()).toBe(200);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();

    // missing consent -> inline error, still on the page, token still usable
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("New password again").fill(PASSWORD);
    await page.getByRole("button", { name: "Save password and log in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Please tick the box to continue." })).toBeVisible();
    expect((await page.request.get(`/api/auth/verify-token?token=${token}`)).status()).toBe(200);
    expect(await cookieNames(page)).not.toContain("td_session");

    // too short -> field error
    await consentBox(page).check();
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("New password again").fill("short");
    await page.getByRole("button", { name: "Save password and log in" }).click();
    await expect(page.getByText(/Use at least 10 characters/).first()).toBeVisible();
    expect((await page.request.get(`/api/auth/verify-token?token=${token}`)).status()).toBe(200);

    // mismatch
    await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("New password again").fill(PASSWORD + "x");
    await page.getByRole("button", { name: "Save password and log in" }).click();
    await expect(page.getByText("The two passwords don't match.")).toBeVisible();

    // success
    await page.getByLabel("New password again").fill(PASSWORD);
    await page.getByLabel("Name (optional)").fill("Alex Tester");
    await page.getByRole("button", { name: "Save password and log in" }).click();
    await page.waitForURL(/\/app\/onboarding/);
    expect(await cookieNames(page)).toContain("td_session");

    await page.goto("/app/account");
    await expect(page.getByLabel("Display name")).toHaveValue("Alex Tester");
    // the link is single use now
    expect((await page.request.get(`/api/auth/verify-token?token=${token}`)).status()).toBe(400);
    expect(sql(`select email_verified_at is not null from users where email='${email}'`)).toBe("t");
  } finally {
    test.info().annotations.push({ type: "404s during signup->confirm", description: notFound.join(" | ") || "none" });
    test.info().annotations.push({ type: "console errors", description: consoleErrors.join(" | ") || "none" });
    dropUser(email);
  }
  expect.soft(notFound, "404 responses during signup -> confirm -> onboarding").toEqual([]);
});

test("unconfirmed: login fails generically, re-signup voids the earlier link, send-again works", async ({ page }) => {
  const email = uniqueEmail("unconf");
  try {
    await uiSignup(page, email);
    const first = await mailLink(email, "Confirm your email");

    // login with any password -> generic message, no session
    await page.goto("/login");
    await uiLogin(page, email, "whatever password 123");
    await expect(page.getByText(GENERIC)).toBeVisible();
    expect(await cookieNames(page)).not.toContain("td_session");
    expect(sql(`select count(*) from sessions s join users u on u.id=s.user_id where u.email='${email}'`)).toBe("0");
    expect(sql(`select password_hash is null from users where email='${email}'`)).toBe("t");

    // sign up again with the same address
    const since = Date.now() - 1000;
    await uiSignup(page, email);
    const second = await mailLink(email, "Confirm your email", since);
    expect(second).not.toBe(first);
    await page.goto(first);
    await expect(page.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
    await page.goto(second);
    await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  } finally {
    dropUser(email);
  }
});

test("unconfirmed: send-again button delivers a fresh confirm link that replaces the old one", async ({ page }) => {
  const email = uniqueEmail("resend");
  try {
    await uiSignup(page, email);
    const first = await mailLink(email, "Confirm your email");
    const since = Date.now() - 500;
    await page.getByRole("button", { name: "Didn't get it? Send again" }).click();
    await expect(page.getByText(/Sent again/)).toBeVisible();
    const fresh = await mailLink(email, "Confirm your email", since);
    expect(fresh).not.toBe(first);
    expect((await page.request.get(`/api/auth/verify-token?token=${tokenOf(first)}`)).status()).toBe(400);
    expect((await page.request.get(`/api/auth/verify-token?token=${tokenOf(fresh)}`)).status()).toBe(200);
  } finally {
    dropUser(email);
  }
});

test("unconfirmed: login-page resend, magic link and forgot-password all send a confirm link, never a reset/login link", async ({ page }) => {
  const u = seedUser({ verified: false, password: null });
  const f = seedUser({ verified: false, password: null });
  try {
    // login-page resend
    await page.goto("/login");
    await page.getByText("Never got your confirmation email?").click();
    await page.getByLabel("Your email").fill(u.email);
    await page.getByRole("button", { name: "Send me a new confirmation link" }).click();
    await expect(page.getByText(/a new link is on its way/)).toBeVisible();
    const m1 = await waitForMail(u.email, "Confirm your email");
    expect(m1.text).toContain("/verify-email?");

    // magic link on the login page for the same unconfirmed address -> another confirm link
    const since = Date.now() - 500;
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(u.email);
    await page.getByRole("button", { name: "Email me a login link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const m2 = await waitForMail(u.email, "Confirm your email", since);
    expect(m2.text).toContain("/verify-email?");
    expect(await mailCount(u.email)).toBe(2);

    // forgot password on an unconfirmed address
    await page.goto("/forgot-password");
    await page.getByLabel("Email", { exact: true }).fill(f.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const m3 = await waitForMail(f.email, "Confirm your email");
    expect(m3.text).toContain("/verify-email?");
    expect(m3.text).not.toContain("/reset-password");
    await page.waitForTimeout(800);
    expect(await mailCount(f.email)).toBe(1);

    // the confirm link asks for a password (there is none yet)
    const link = await mailLink(f.email, "Confirm your email");
    await page.goto(link);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    expect(sql(`select count(*) from sessions where user_id='${f.id}'`)).toBe("0");
  } finally {
    dropUser(u.email);
    dropUser(f.email);
  }
});

test("takeover regression: attacker signing up a victim's address gets no session and no password", async ({ browser, page }) => {
  const victim = uniqueEmail("victim");
  try {
    // attacker's browser
    await uiSignup(page, victim);
    expect(await cookieNames(page)).not.toContain("td_session");
    // the strict schema refuses a password / name on signup
    const bad = await apiPost(page, "/api/auth/signup", { email: victim, password: "attacker password 1" });
    expect(bad.status()).toBe(400);
    const bad2 = await apiPost(page, "/api/auth/signup", { email: victim, displayName: "x" });
    expect(bad2.status()).toBe(400);
    for (const pw of ["attacker password 1", "another guess 22"]) {
      await page.goto("/login");
      await uiLogin(page, victim, pw);
      await expect(page.getByText(GENERIC)).toBeVisible();
    }
    expect(await cookieNames(page)).not.toContain("td_session");
    expect(((await (await page.request.get("/api/auth/session")).json()) as { user: unknown }).user).toBeNull();
    expect(sql(`select count(*) from sessions s join users u on u.id=s.user_id where u.email='${victim}'`)).toBe("0");

    // the victim confirms with their own password in another browser
    const link = await mailLink(victim, "Confirm your email");
    const vctx = await browser.newContext({ baseURL: BASE });
    const vp = await vctx.newPage();
    await vp.goto(link);
    await vp.getByRole("button", { name: "Continue" }).click();
    await vp.getByLabel("New password", { exact: true }).fill("victims own secret 77");
    await vp.getByLabel("New password again").fill("victims own secret 77");
    await consentBox(vp).check();
    await vp.getByRole("button", { name: "Save password and log in" }).click();
    await vp.waitForURL(/\/app/);
    await vctx.close();

    // the attacker still can't get in, with either of their guesses
    await page.goto("/login");
    await uiLogin(page, victim, "attacker password 1");
    await expect(page.getByText(GENERIC)).toBeVisible();
    expect(await cookieNames(page)).not.toContain("td_session");
  } finally {
    dropUser(victim);
  }
});

async function freshLogin(browser: Browser, path = "/login") {
  const ctx = await browser.newContext({ baseURL: BASE });
  const p = await ctx.newPage();
  await p.goto(path);
  return { ctx, p };
}

test("login variants: password, next honoured, external next ignored", async ({ browser }) => {
  const u = seedUser();
  try {
    let { ctx, p } = await freshLogin(browser);
    await uiLogin(p, u.email, u.password);
    await p.waitForURL(/localhost:3000\/app$/);
    await expect(p.getByRole("heading", { name: "Your servers" })).toBeVisible();
    await ctx.close();

    ({ ctx, p } = await freshLogin(browser, "/login?next=/app/account"));
    await uiLogin(p, u.email, u.password);
    await p.waitForURL(/\/app\/account$/);
    await ctx.close();

    ({ ctx, p } = await freshLogin(browser, "/login?next=https%3A%2F%2Fevil.example%2Fx"));
    await uiLogin(p, u.email, u.password);
    await p.waitForURL(/localhost:3000\/app$/);
    expect(p.url()).not.toContain("evil.example");
    await ctx.close();

    // API: a hostile next is dropped
    ({ ctx, p } = await freshLogin(browser));
    const r = await apiPost(p, "/api/auth/login", { email: u.email, password: u.password, next: "//evil.example" });
    expect(r.status()).toBe(400);
    await ctx.close();
  } finally {
    dropUser(u.email);
  }
});

test("login variants: magic link (Continue -> /app), next kept through the link", async ({ browser }) => {
  const u = seedUser();
  try {
    const { ctx, p } = await freshLogin(browser, "/login?next=/app/account");
    await p.getByLabel("Email", { exact: true }).fill(u.email);
    await p.getByRole("button", { name: "Email me a login link" }).click();
    await expect(p.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const link = await mailLink(u.email, "sign-in link");
    await p.goto(link);
    await expect(p.getByRole("heading", { name: "Log in with this link" })).toBeVisible();
    await p.getByRole("button", { name: "Continue" }).click();
    await p.waitForURL(/\/app\/account$/);
    await ctx.close();
  } finally {
    dropUser(u.email);
  }
});

test("login variants: forgot/reset password ends other sessions and logs in", async ({ browser }) => {
  const u = seedUser();
  try {
    const old = await contextFor(browser, u);
    const op = await old.newPage();
    await op.goto("/app");
    await expect(op.getByRole("heading", { name: "Your servers" })).toBeVisible();

    const { ctx, p } = await freshLogin(browser, "/forgot-password");
    await p.getByLabel("Email", { exact: true }).fill(u.email);
    await p.getByRole("button", { name: "Send reset link" }).click();
    await expect(p.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const link = await mailLink(u.email, "Reset your");
    expect(link).toContain("/reset-password?");
    await p.goto(link);
    await p.getByLabel("New password", { exact: true }).fill("brand new password 55");
    await p.getByLabel("New password again").fill("brand new password 55");
    await p.getByRole("button", { name: "Save new password" }).click();
    await p.waitForURL(/\/app$/);
    expect(await cookieNames(p)).toContain("td_session");

    await op.reload();
    await op.waitForURL(/\/login/);
    // single use
    await p.goto(link);
    await p.getByLabel("New password", { exact: true }).fill("yet another password 66");
    await p.getByLabel("New password again").fill("yet another password 66");
    await p.getByRole("button", { name: "Save new password" }).click();
    await expect(p.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
    await ctx.close();
    await old.close();
  } finally {
    dropUser(u.email);
  }
});

test("a signed-in user opening someone else's magic link is asked first; Cancel goes to /app", async ({ browser }) => {
  const a = seedUser();
  const b = seedUser();
  try {
    const anon = await browser.newContext({ baseURL: BASE });
    const ap = await anon.newPage();
    await ap.goto("/login");
    const r = await apiPost(ap, "/api/auth/magic-link", { email: b.email });
    expect(r.status()).toBe(200);
    const link = await mailLink(b.email, "sign-in link");
    await anon.close();

    const ctx = await contextFor(browser, a);
    const p = await ctx.newPage();
    await p.goto(link);
    await expect(p.getByText(a.email)).toBeVisible();
    await expect(p.getByText(/Continue as the account from this link\?/)).toBeVisible();
    await p.getByRole("link", { name: "Cancel" }).click();
    await p.waitForURL(/localhost:3000\/app$/);
    const sess = (await (await p.request.get("/api/auth/session")).json()) as { user: { email: string } };
    expect(sess.user.email).toBe(a.email);
    // the token was not consumed by Cancel
    expect((await p.request.get(`/api/auth/verify-token?token=${tokenOf(link)}`)).status()).toBe(200);
    await ctx.close();
  } finally {
    dropUser(a.email);
    dropUser(b.email);
  }
});

test("unauthenticated /app and deep links redirect to /login with next", async ({ page }) => {
  await page.goto("/app");
  await page.waitForURL(/\/login\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next")!)).toBe("/app");
  await page.goto("/app/servers/00000000-0000-0000-0000-000000000000/settings");
  await page.waitForURL(/\/login\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next")!)).toContain("/app/servers/");
});

test("signup API: strict body (consent field refused); /signup/discord without a cookie shows the expired state", async ({ page }) => {
  const email = uniqueEmail("strict");
  const r = await apiPost(page, "/api/auth/signup", { email, consent: true });
  expect(r.status()).toBe(400);
  await page.goto("/signup/discord");
  await expect(page.getByRole("heading", { name: "This sign-up has expired" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try again with Discord" })).toBeVisible();
  await expect(page.getByRole("link", { name: "sign up with email" })).toHaveAttribute("href", "/signup");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});
