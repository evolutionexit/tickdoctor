import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { AUTH_LIMITS, CSRF_COOKIE, SESSION_COOKIE, discordPendingResponse, sessionResponse, verifyTokenInfo } from "@tickdoctor/shared";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../src/auth/crypto.js";
import { createServer, ensureUser } from "../src/servers.js";
import { issueEmailToken, purgeExpiredAuth, purgePendingUsers } from "../src/auth/store.js";
import { isUniqueViolation } from "../src/routes/auth.js";
import { Client, PASSWORD, flush, freshEmail, makeHarness, tokenFrom, verifiedUser, type Harness } from "./app-helpers.js";
import { WEB_ORIGIN, handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeAll(resetStorage);

const one = async <T>(q: ReturnType<typeof sql>) => ((await handle.db.execute(q)) as unknown as T[])[0];
const userRow = (email: string) =>
  one<{ id: string; password_hash: string | null; verified: boolean; display_name: string | null; consent_at: Date | null }>(
    sql`select id, password_hash, email_verified_at is not null as verified, display_name, consent_at from users where email = ${email}`,
  );
const sessionCount = async (userId: string) => (await one<{ n: number }>(sql`select count(*)::int as n from sessions where user_id = ${userId}`))!.n;

async function signup(h: Harness, email: string, extra: Record<string, unknown> = {}) {
  const c = await new Client(h.app).init();
  const r = await c.post("/api/auth/signup", { email, ...extra });
  await flush();
  return { c, r };
}

describe("password hashing", () => {
  it("scrypt with encoded params; verifies; malformed never throws", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(h).toMatch(/^scrypt\$15\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
    expect(await verifyPassword("hunter2hunter3", h)).toBe(false);
    expect(await verifyPassword("x", "scrypt$99$8$1$aaaa$bbbb")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("GET /api/auth/session + CSRF", () => {
  const h = makeHarness();

  it("never 401; issues a readable td_csrf cookie once", async () => {
    const res = await h.app.request("/api/auth/session");
    expect(res.status).toBe(200);
    expect(sessionResponse.parse(await res.json())).toEqual({ user: null });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith(`${CSRF_COOKIE}=`))!;
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).not.toMatch(/HttpOnly/i);
    const again = await h.app.request("/api/auth/session", { headers: { cookie: sc.split(";")[0]! } });
    expect(again.headers.getSetCookie().some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(false);
  });

  it("rejects non-GET without Origin, with a foreign Origin, without/with a wrong token, without the cookie", async () => {
    const c = await new Client(h.app).init();
    const body = { email: freshEmail() };
    const cases = [
      await c.req("POST", "/api/auth/signup", body, { origin: null }),
      await c.req("POST", "/api/auth/signup", body, { origin: "https://evil.example" }),
      await c.req("POST", "/api/auth/signup", body, { csrf: false }),
      await c.req("POST", "/api/auth/signup", body, { headers: { "x-csrf-token": "x".repeat(43) } }),
      await new Client(h.app).req("POST", "/api/auth/signup", body, { headers: { "x-csrf-token": c.cookies.get(CSRF_COOKIE)! } }),
      await c.req("POST", "/api/auth/logout", {}, { origin: null }),
      await c.req("PATCH", "/api/account", { displayName: "x" }, { csrf: false }),
      await c.req("DELETE", "/api/servers/00000000-0000-4000-8000-000000000000", { confirmName: "x" }, { csrf: false }),
    ];
    for (const res of cases) {
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("csrf_failed");
    }
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("the Phase 1 waitlist keeps its own guard (no CSRF token needed)", async () => {
    const res = await h.app.request("/api/waitlist", {
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email: freshEmail(), source: "other", consent: true }),
    });
    expect(res.status).toBe(200);
  });
});

describe("signup (email only) and confirmation", () => {
  const h = makeHarness();

  it("new email: 200 {ok}, confirm mail, pending row without password or consent, no session", async () => {
    const email = freshEmail();
    const { c, r } = await signup(h, email.toUpperCase());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    const mail = h.mailer.last(email)!;
    expect(mail.subject).toContain("TickDoctor");
    expect(mail.text).toContain("Confirm your email and choose your password");
    expect(mail.text).toContain("If you didn't sign up, ignore this email — nothing happens until the link is used.");
    expect(mail.text).toMatch(new RegExp(`${WEB_ORIGIN}/verify-email\\?token=[A-Za-z0-9_-]+&kind=verify`));
    const u = await userRow(email);
    expect(u).toMatchObject({ password_hash: null, verified: false, display_name: null });
    expect(u!.consent_at).toBeNull(); // signup records no consent (contract 38dc933); the password page does
    const t = tokenFrom(mail.text);
    expect(JSON.stringify(await handle.db.execute(sql`select * from email_tokens`))).not.toContain(t);
    expect(await one(sql`select 1 from email_tokens where token_hash = ${sha256Hex(t)}`)).toBeTruthy();
  });

  it("strict body: a password, displayName or consent field, or junk → 400 (nothing stored)", async () => {
    const c = await new Client(h.app).init();
    const email = freshEmail();
    for (const body of [
      { email, password: "my secret password" },
      { email, displayName: "Name moved to the confirm step" },
      { email, consent: true },
      { email, consent: false },
      { email: "nope" },
      {},
    ]) {
      const r = await c.post("/api/auth/signup", body);
      expect(r.status).toBe(400);
      const b = await r.json();
      expect(b.error.code).toBe("invalid_request");
      expect(JSON.stringify(b)).not.toContain("my secret password");
    }
    expect(await userRow(email)).toBeUndefined();
    for (const next of ["//evil.example", "https://evil.example", "/\\evil"]) {
      const r = await c.post("/api/auth/signup", { email: freshEmail(), next });
      expect(r.status).toBe(400);
      expect((await r.json()).error.fields.next).toBeTruthy();
    }
  });

  it("GET verify-token is read-only; POST verify without a password → 400 and the token stays usable", async () => {
    const email = freshEmail();
    await signup(h, email, { next: "/app/onboarding" });
    const token = tokenFrom(h.mailer.last(email)!.text);
    const c = await new Client(h.app).init();
    for (let i = 0; i < 2; i++) {
      const info = await c.get(`/api/auth/verify-token?token=${token}`);
      expect(info.status).toBe(200);
      expect(verifyTokenInfo.parse(await info.json())).toEqual({ kind: "verify", needsPassword: true });
    }
    expect((await one<{ used_at: Date | null }>(sql`select used_at from email_tokens where token_hash = ${sha256Hex(token)}`))!.used_at).toBeNull();
    for (const q of ["x".repeat(43), "short", ""]) {
      const r = await c.get(`/api/auth/verify-token?token=${q}`);
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_token");
    }

    const noPw = await c.post("/api/auth/verify", { token });
    expect(noPw.status).toBe(400);
    expect((await noPw.json()).error).toMatchObject({ code: "invalid_request", fields: { password: expect.any(String) } });
    const shortPw = await c.post("/api/auth/verify", { token, password: "short", consent: true });
    expect(shortPw.status).toBe(400);
    expect((await shortPw.json()).error.fields.password).toBeTruthy();
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);

    const ok = await c.post("/api/auth/verify", { token, password: PASSWORD, consent: true });
    expect(ok.status).toBe(200);
    const body = sessionResponse.parse(await ok.json());
    expect(body).toMatchObject({ next: "/app/onboarding", user: { email, emailVerified: true, hasPassword: true } });
    const sc = ok.headers.getSetCookie().find((x) => x.startsWith(`${SESSION_COOKIE}=`))!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Max-Age=2592000/);
    expect(sc).not.toMatch(/Secure/);

    // Single use; verify-token now says invalid too.
    const again = await new Client(h.app).init();
    expect((await again.post("/api/auth/verify", { token, password: PASSWORD, consent: true })).status).toBe(400);
    expect((await again.get(`/api/auth/verify-token?token=${token}`)).status).toBe(400);
    expect((await again.post("/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  });

  it("verify response `next` defaults: /app/onboarding for a confirm link, /app for a magic link", async () => {
    const email = freshEmail();
    await signup(h, email);
    const c = await new Client(h.app).init();
    const v = await c.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)!.text), password: PASSWORD, consent: true });
    expect(sessionResponse.parse(await v.json()).next).toBe("/app/onboarding");
    await c.post("/api/auth/magic-link", { email });
    await flush();
    const m = await c.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)!.text) });
    expect(sessionResponse.parse(await m.json()).next).toBe("/app");
  });

  it("confirm link expires after 24 h", async () => {
    const h2 = makeHarness();
    const email = freshEmail();
    await signup(h2, email);
    h2.clock.now += 24 * 3_600_000 + 1000;
    const c = await new Client(h2.app).init();
    expect((await c.post("/api/auth/verify", { token: tokenFrom(h2.mailer.last(email)!.text), password: PASSWORD, consent: true })).status).toBe(400);
  });

  it("confirmed email: identical response, 'already have an account' magic link, nothing changes", async () => {
    const { email, id } = await verifiedUser(h);
    const before = await userRow(email);
    const r1 = await signup(h, email);
    const r2 = await signup(h, freshEmail());
    expect([r1.r.status, r2.r.status]).toEqual([200, 200]);
    expect(await r1.r.text()).toBe(await r2.r.text());
    expect(r1.r.headers.getSetCookie()).toEqual([]);
    expect(r2.r.headers.getSetCookie()).toEqual([]);
    const mail = h.mailer.last(email)!;
    expect(mail.subject).toMatch(/already have/);
    expect(mail.text).toContain("kind=magic");
    expect(mail.text).not.toMatch(/signing up before|signup password/i);
    expect(await userRow(email)).toEqual(before);
    expect(await sessionCount(id)).toBe(1);
    const v = await r1.c.post("/api/auth/verify", { token: tokenFrom(mail.text) });
    expect(v.status).toBe(200);
    expect(sessionResponse.parse(await v.json()).user).toMatchObject({ email, hasPassword: true });
  });

  it("a mail failure is logged, never revealed (still 200)", async () => {
    const h2 = makeHarness();
    h2.mailer.fail = true;
    const { r } = await signup(h2, freshEmail());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(h2.logs.some((l) => l.includes("mail send failed"))).toBe(true);
    expect(h2.logs.join("\n")).not.toMatch(/token=/);
  });
});

describe("pre-registering someone else's email (Michel's model)", () => {
  const h = makeHarness();

  it("attacker gets no session and stores no password; the victim's confirm link lets them choose their own", async () => {
    const victim = freshEmail("victim");
    const attacker = await new Client(h.app).init();
    expect((await attacker.post("/api/auth/signup", { email: victim })).status).toBe(200);
    expect(attacker.cookies.has(SESSION_COOKIE)).toBe(false);
    const row = (await userRow(victim))!;
    expect(row.password_hash).toBeNull();
    expect(await sessionCount(row.id)).toBe(0);
    // Without the link, nobody can log in (no password exists).
    expect((await attacker.post("/api/auth/login", { email: victim, password: "anything at all" })).status).toBe(401);

    await flush();
    const owner = await new Client(h.app).init();
    const v = await owner.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(victim)!.text), password: "victim's own password", consent: true });
    expect(v.status).toBe(200);
    expect((await (await attacker.get("/api/auth/session")).json()).user).toBeNull();
    expect((await new Client(h.app).init().then((x) => x.post("/api/auth/login", { email: victim, password: "victim's own password" }))).status).toBe(200);
  });

  it("re-signup on a pending email resets the row (password, name, consent, oauth) and voids the earlier link", async () => {
    const victim = freshEmail("victim");
    await signup(h, victim);
    const victimLink = tokenFrom(h.mailer.last(victim)!.text);
    // Leftovers that must not survive a re-signup (pre-seeded: legacy data / earlier model with a signup consent).
    const { id } = (await userRow(victim))!;
    await handle.db.execute(
      sql`update users set password_hash = ${await hashPassword("leftover password")}, display_name = 'Old name', consent_at = now() where id = ${id}`,
    );
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${"7" + Date.now()}, ${id})`);
    h.clock.now += 5000;
    await signup(h, victim);
    const second = tokenFrom(h.mailer.last(victim)!.text);
    expect(second).not.toBe(victimLink);
    const row = (await userRow(victim))!;
    expect(row.display_name).toBeNull(); // nothing kept from the earlier attempt
    expect(row.password_hash).toBeNull();
    expect(await one(sql`select 1 from oauth_accounts where user_id = ${id}`)).toBeUndefined();
    expect(row.consent_at).toBeNull();
    const c = await new Client(h.app).init();
    expect((await c.get(`/api/auth/verify-token?token=${victimLink}`)).status).toBe(400);
    expect((await c.post("/api/auth/verify", { token: victimLink, password: PASSWORD, consent: true })).status).toBe(400);
    expect((await c.post("/api/auth/verify", { token: second, password: PASSWORD, consent: true })).status).toBe(200);
  });

  it("a session of an unconfirmed user (inserted directly) is rejected and deleted", async () => {
    const email = freshEmail("pending");
    await signup(h, email);
    const { id } = (await userRow(email))!;
    const token = randomToken();
    const now = h.clock.now;
    await handle.db.execute(sql`insert into sessions (id_hash, user_id, created_at, expires_at, last_used_at)
      values (${sha256Hex(token)}, ${id}, ${new Date(now).toISOString()}::timestamptz, ${new Date(now + 86_400_000).toISOString()}::timestamptz, ${new Date(now).toISOString()}::timestamptz)`);
    const c = new Client(h.app);
    c.cookies.set(SESSION_COOKIE, token);
    await c.init();
    expect((await (await c.get("/api/auth/session")).json()).user).toBeNull();
    expect((await c.get("/api/servers")).status).toBe(401);
    expect(await sessionCount(id)).toBe(0);
  });

  it("CLI-created user (no password) is claimed through a confirm link", async () => {
    const email = freshEmail("cli");
    await ensureUser(handle.db, email, "CLI name");
    const { r } = await signup(h, email);
    expect(r.status).toBe(200);
    const mail = h.mailer.last(email)!;
    expect(mail.text).toContain("kind=verify");
    const c = await new Client(h.app).init();
    const v = await c.post("/api/auth/verify", { token: tokenFrom(mail.text), password: PASSWORD, consent: true });
    expect(sessionResponse.parse(await v.json()).user).toMatchObject({ email, emailVerified: true, hasPassword: true, plan: "free" });
  });
});

describe("login / logout / sessions", () => {
  const h = makeHarness();

  it("login: 200 + cookie; wrong password, unknown, unconfirmed and password-less accounts all give the same 401", async () => {
    const { email } = await verifiedUser(h);
    const pending = freshEmail("pending");
    await signup(h, pending);
    const cliEmail = freshEmail("cli");
    await ensureUser(handle.db, cliEmail);
    // Even a legacy unconfirmed row that still has a hash can't log in.
    const legacy = freshEmail("legacy");
    await ensureUser(handle.db, legacy);
    await handle.db.execute(sql`update users set password_hash = ${await hashPassword("legacy password!")} where email = ${legacy}`);

    const c = await new Client(h.app).init();
    const ok = await c.post("/api/auth/login", { email, password: PASSWORD, next: "/app/servers/x" });
    expect(ok.status).toBe(200);
    expect(sessionResponse.parse(await ok.json())).toMatchObject({ user: { email, hasPassword: true }, next: "/app/servers/x" });

    const bodies: string[] = [];
    for (const creds of [
      { email, password: "wrong password!" },
      { email: freshEmail("nobody"), password: "wrong password!" },
      { email: pending, password: "wrong password!" },
      { email: cliEmail, password: "wrong password!" },
      { email: legacy, password: "legacy password!" },
    ]) {
      const r = await new Client(h.app).init().then((x) => x.post("/api/auth/login", creds));
      expect(r.status).toBe(401);
      expect(r.headers.getSetCookie().some((x) => x.startsWith(SESSION_COOKIE))).toBe(false);
      bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).error.code).toBe("invalid_credentials");
  });

  it("unknown emails still pay for a scrypt check (timing)", async () => {
    const { email } = await verifiedUser(h);
    const time = async (e: string) => {
      const c = await new Client(h.app).init();
      const t0 = performance.now();
      await c.post("/api/auth/login", { email: e, password: "wrong password!" });
      return performance.now() - t0;
    };
    await time(freshEmail("warm")); // first call builds the dummy hash
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < 3; i++) {
      known += await time(email);
      unknown += await time(freshEmail("nobody"));
    }
    expect(unknown / known).toBeGreaterThan(0.4);
    expect(unknown / known).toBeLessThan(2.5);
  });

  it("logout deletes the session; logout-all ends every session", async () => {
    const { client, email } = await verifiedUser(h);
    const other = await new Client(h.app).init();
    await other.post("/api/auth/login", { email, password: PASSWORD });
    const third = await new Client(h.app).init();
    await third.post("/api/auth/login", { email, password: PASSWORD });

    expect((await client.post("/api/auth/logout")).status).toBe(200);
    expect(client.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await (await client.get("/api/auth/session")).json()).user).toBeNull();
    expect((await (await other.get("/api/auth/session")).json()).user.email).toBe(email);

    expect((await new Client(h.app).init().then((c) => c.post("/api/auth/logout-all"))).status).toBe(401);
    expect((await other.post("/api/auth/logout-all")).status).toBe(200);
    expect((await (await third.get("/api/auth/session")).json()).user).toBeNull();
  });

  it("sessions: stored as sha256, 30 days sliding, touched at most once a minute, expire", async () => {
    const h2 = makeHarness();
    const { client } = await verifiedUser(h2);
    const token = client.cookies.get(SESSION_COOKIE)!;
    const row = await one<{ last_used_at: Date }>(sql`select last_used_at from sessions where id_hash = ${sha256Hex(token)}`);
    expect(row).toBeTruthy();
    expect(JSON.stringify(await handle.db.execute(sql`select * from sessions`))).not.toContain(token);

    h2.clock.now += 30_000;
    await client.get("/api/auth/session");
    const same = await one<{ last_used_at: Date }>(sql`select last_used_at from sessions where id_hash = ${sha256Hex(token)}`);
    expect(new Date(same!.last_used_at).getTime()).toBe(new Date(row!.last_used_at).getTime());

    h2.clock.now += 20 * 86_400_000;
    const r = await client.get("/api/auth/session");
    expect((await r.json()).user).not.toBeNull();
    expect(r.headers.getSetCookie().some((x) => x.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    h2.clock.now += 20 * 86_400_000;
    expect((await (await client.get("/api/auth/session")).json()).user).not.toBeNull();
    h2.clock.now += 30 * 86_400_000 + 1000;
    const dead = await client.get("/api/auth/session");
    expect((await dead.json()).user).toBeNull();
    expect(client.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await client.get("/api/servers")).status).toBe(401);
  });

  it("td_csrf changes on login and the pre-login token stops working", async () => {
    const { email } = await verifiedUser(h);
    const c = await new Client(h.app).init();
    const before = c.cookies.get(CSRF_COOKIE)!;
    expect((await c.post("/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
    const after = c.cookies.get(CSRF_COOKIE)!;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect((await c.req("PATCH", "/api/account", { displayName: "x" }, { headers: { "x-csrf-token": before } })).status).toBe(403);
    expect((await c.req("PATCH", "/api/account", { displayName: "x" })).status).toBe(200);
  });
});

describe("magic link, forgot/reset password, resend verification", () => {
  const h = makeHarness();

  it("magic link: unknown → 200 nothing sent; confirmed → magic link; unconfirmed → confirm link instead", async () => {
    const c = await new Client(h.app).init();
    const unknown = freshEmail("nobody");
    const r1 = await c.post("/api/auth/magic-link", { email: unknown });
    expect(await r1.json()).toEqual({ ok: true });
    await flush();
    expect(h.mailer.to(unknown)).toHaveLength(0);
    expect(await userRow(unknown)).toBeUndefined();

    const { email } = await verifiedUser(h);
    const r2 = await c.post("/api/auth/magic-link", { email, next: "/app/account" });
    expect(await r2.text()).toBe(JSON.stringify({ ok: true }));
    await flush();
    const mail = h.mailer.last(email)!;
    expect(mail.subject).toMatch(/sign-in link/);
    const token = tokenFrom(mail.text);
    expect(verifyTokenInfo.parse(await (await c.get(`/api/auth/verify-token?token=${token}`)).json())).toEqual({ kind: "magic", needsPassword: false });
    const v = await c.post("/api/auth/verify", { token });
    expect(sessionResponse.parse(await v.json())).toMatchObject({ next: "/app/account", user: { email } });

    const pending = freshEmail("pending");
    await signup(h, pending);
    const first = tokenFrom(h.mailer.last(pending)!.text);
    const r3 = await c.post("/api/auth/magic-link", { email: pending });
    expect(await r3.text()).toBe(JSON.stringify({ ok: true }));
    await flush();
    const m3 = h.mailer.last(pending)!;
    expect(m3.text).toContain("kind=verify");
    expect(m3.subject).toMatch(/Confirm your email/);
    expect((await c.get(`/api/auth/verify-token?token=${first}`)).status).toBe(400); // replaced
  });

  it("magic link expires after 15 min; a newer link voids the older one", async () => {
    const h2 = makeHarness();
    const { email } = await verifiedUser(h2);
    const c = await new Client(h2.app).init();
    await c.post("/api/auth/magic-link", { email });
    await flush();
    const first = tokenFrom(h2.mailer.last(email)!.text);
    await c.post("/api/auth/magic-link", { email });
    await flush();
    const second = tokenFrom(h2.mailer.last(email)!.text);
    expect((await c.post("/api/auth/verify", { token: first })).status).toBe(400);
    h2.clock.now += 15 * 60_000 + 1000;
    expect((await c.post("/api/auth/verify", { token: second })).status).toBe(400);
  });

  it("forgot/reset: same answer for unknown; confirmed → reset link; reset ends other sessions, single use", async () => {
    const { client: old, email } = await verifiedUser(h);
    const c = await new Client(h.app).init();
    const unknown = freshEmail("nobody");
    const a = await c.post("/api/auth/forgot-password", { email: unknown });
    const b = await c.post("/api/auth/forgot-password", { email });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.text()).toBe(await b.text());
    await flush();
    expect(h.mailer.to(unknown)).toHaveLength(0);
    const mail = h.mailer.last(email)!;
    expect(mail.text).toContain(`${WEB_ORIGIN}/reset-password?token=`);
    const token = tokenFrom(mail.text);

    expect((await c.post("/api/auth/verify", { token, password: PASSWORD, consent: true })).status).toBe(400); // not a login token
    const r = await c.post("/api/auth/reset-password", { token, password: "brand new password" });
    expect(r.status).toBe(200);
    expect(sessionResponse.parse(await r.json()).user?.email).toBe(email);
    expect((await (await old.get("/api/auth/session")).json()).user).toBeNull();
    expect((await c.post("/api/auth/reset-password", { token, password: "another password!" })).status).toBe(400);
    const fresh = await new Client(h.app).init();
    expect((await fresh.post("/api/auth/login", { email, password: PASSWORD })).status).toBe(401);
    expect((await fresh.post("/api/auth/login", { email, password: "brand new password" })).status).toBe(200);
  });

  it("forgot-password on an unconfirmed account sends a confirm link, never a reset link", async () => {
    const pending = freshEmail("pending");
    await signup(h, pending);
    const c = await new Client(h.app).init();
    await c.post("/api/auth/forgot-password", { email: pending });
    await flush();
    const m = h.mailer.last(pending)!;
    expect(m.text).toContain("kind=verify");
    expect(m.text).not.toContain("/reset-password");
    expect(await one(sql`select 1 from email_tokens t join users u on u.id = t.user_id where u.email = ${pending} and t.kind = 'reset'`)).toBeUndefined();
  });

  it("reset token expires after 60 min", async () => {
    const h2 = makeHarness();
    const { email } = await verifiedUser(h2);
    const c = await new Client(h2.app).init();
    await c.post("/api/auth/forgot-password", { email });
    await flush();
    h2.clock.now += 60 * 60_000 + 1000;
    expect((await c.post("/api/auth/reset-password", { token: tokenFrom(h2.mailer.last(email)!.text), password: "brand new password" })).status).toBe(400);
  });

  it("resend-verification { email }: no session needed, always 200; only unconfirmed accounts get a (new) confirm link", async () => {
    const c = await new Client(h.app).init();
    const pending = freshEmail("pending");
    await signup(h, pending);
    const first = tokenFrom(h.mailer.last(pending)!.text);
    const { email: confirmed } = await verifiedUser(h);
    const unknown = freshEmail("nobody");
    h.mailer.clear();
    const res = [];
    for (const email of [pending, confirmed, unknown]) res.push(await c.post("/api/auth/resend-verification", { email }));
    for (const r of res) {
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    await flush();
    expect(h.mailer.sent.map((m) => m.to)).toEqual([pending]);
    expect(h.mailer.last(pending)!.text).toContain("kind=verify");
    expect((await c.get(`/api/auth/verify-token?token=${first}`)).status).toBe(400);
    expect((await c.post("/api/auth/resend-verification", {})).status).toBe(400);
  });
});

describe("token endpoints (M1)", () => {
  it("reset-password and confirm hash only after a valid token (invalid tokens are cheap)", async () => {
    const h = makeHarness();
    const c = await new Client(h.app).init();
    const t0 = performance.now();
    await hashPassword("some password here");
    const hashMs = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 4; i++) {
      expect((await c.post("/api/auth/reset-password", { token: "y".repeat(43), password: "brand new password" })).status).toBe(400);
      expect((await c.post("/api/auth/verify", { token: "y".repeat(43), password: "brand new password", consent: true })).status).toBe(400);
    }
    expect((performance.now() - t1) / 8).toBeLessThan(hashMs * 0.6);
  });

  it("verify-token, verify and reset-password share a per-IP limit", async () => {
    const h = makeHarness();
    const c = await new Client(h.app).init();
    const n = AUTH_LIMITS.tokenAttemptsPerIpPer15Min;
    for (let i = 0; i < n; i++) {
      const r =
        i % 3 === 0
          ? await c.get(`/api/auth/verify-token?token=${"x".repeat(43)}`)
          : i % 3 === 1
            ? await c.post("/api/auth/verify", { token: "x".repeat(43), password: PASSWORD, consent: true })
            : await c.post("/api/auth/reset-password", { token: "x".repeat(43), password: "brand new password" });
      expect(r.status).toBe(400);
    }
    const r = await c.get(`/api/auth/verify-token?token=${"x".repeat(43)}`);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await c.post("/api/auth/verify", { token: "x".repeat(43) })).status).toBe(429);
    expect((await new Client(h.app).init().then((x) => x.post("/api/auth/verify", { token: "x".repeat(43) }))).status).toBe(400);
  });
});

describe("rate limits (AUTH_LIMITS)", () => {
  it("login per IP and per email", async () => {
    const h = makeHarness();
    const c = await new Client(h.app).init();
    let last: Response | undefined;
    for (let i = 0; i <= AUTH_LIMITS.loginPerIpPer15Min; i++) last = await c.post("/api/auth/login", { email: freshEmail(), password: "x" });
    expect(last!.status).toBe(429);
    expect((await last!.json()).error.code).toBe("rate_limited");
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);

    const email = freshEmail();
    for (let i = 0; i < AUTH_LIMITS.loginPerEmailPer15Min; i++) {
      expect((await new Client(h.app).init().then((x) => x.post("/api/auth/login", { email, password: "x" }))).status).toBe(401);
    }
    expect((await new Client(h.app).init().then((x) => x.post("/api/auth/login", { email, password: "x" }))).status).toBe(429);
    h.clock.now += 15 * 60_000 + 1000;
    expect((await new Client(h.app).init().then((x) => x.post("/api/auth/login", { email, password: "x" }))).status).toBe(401);
  });

  it("IPv6 clients are limited per /64", async () => {
    const h = makeHarness();
    let last: Response | undefined;
    for (let i = 0; i <= AUTH_LIMITS.loginPerIpPer15Min; i++) {
      const c = await new Client(h.app, `2001:db8:aa:bb:${i.toString(16)}::1`).init();
      last = await c.post("/api/auth/login", { email: freshEmail(), password: "x" });
    }
    expect(last!.status).toBe(429);
    const otherNet = await new Client(h.app, "2001:db8:aa:cc::1").init();
    expect((await otherNet.post("/api/auth/login", { email: freshEmail(), password: "x" })).status).toBe(401);
  });

  it("signup per IP", async () => {
    const h = makeHarness();
    const c = await new Client(h.app).init();
    for (let i = 0; i < AUTH_LIMITS.signupPerIpPerHour; i++) {
      expect((await c.post("/api/auth/signup", { email: freshEmail() })).status).toBe(200);
    }
    expect((await c.post("/api/auth/signup", { email: freshEmail() })).status).toBe(429);
  });

  it("email sends per email (shared by magic-link, forgot-password, resend) and per IP", async () => {
    const h = makeHarness();
    const { email } = await verifiedUser(h);
    const c = () => new Client(h.app).init();
    // The signup inside verifiedUser counted once already.
    expect((await (await c()).post("/api/auth/magic-link", { email })).status).toBe(200);
    expect((await (await c()).post("/api/auth/forgot-password", { email })).status).toBe(200);
    const r = await (await c()).post("/api/auth/resend-verification", { email });
    expect(r.status).toBe(429);

    const one = await c();
    for (let i = 0; i < AUTH_LIMITS.emailSendsPerIpPerHour; i++) {
      expect((await one.post("/api/auth/magic-link", { email: freshEmail() })).status).toBe(200);
    }
    expect((await one.post("/api/auth/magic-link", { email: freshEmail() })).status).toBe(429);
  });

  it("signup over the per-email send limit: still {ok}, no mail, but the earlier link is void", async () => {
    const h = makeHarness();
    const email = freshEmail();
    for (let i = 0; i < AUTH_LIMITS.emailSendsPerEmailPer15Min; i++) await signup(h, email);
    const last = tokenFrom(h.mailer.last(email)!.text);
    const sent = h.mailer.to(email).length;
    const { r } = await signup(h, email);
    expect(await r.json()).toEqual({ ok: true });
    expect(h.mailer.to(email)).toHaveLength(sent);
    const c = await new Client(h.app).init();
    expect((await c.get(`/api/auth/verify-token?token=${last}`)).status).toBe(400);
  });
});

describe("account", () => {
  const h = makeHarness();

  it("GET/PATCH /api/account; password change needs the current one, ends other sessions, voids links", async () => {
    const { client, email } = await verifiedUser(h);
    expect((await new Client(h.app).init().then((c) => c.get("/api/account"))).status).toBe(401);
    expect((await (await client.get("/api/account")).json()).user.email).toBe(email);
    const p = await client.req("PATCH", "/api/account", { displayName: "  Sam  " });
    expect((await p.json()).user.displayName).toBe("Sam");

    const other = await new Client(h.app).init();
    await other.post("/api/auth/login", { email, password: PASSWORD });
    await other.post("/api/auth/forgot-password", { email });
    await flush();
    const reset = tokenFrom(h.mailer.last(email)!.text);
    await other.post("/api/auth/magic-link", { email });
    await flush();
    const magic = tokenFrom(h.mailer.last(email)!.text);

    const bad = await client.post("/api/account/password", { newPassword: "new password 123" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.fields.currentPassword).toBeTruthy();
    const ok = await client.post("/api/account/password", { currentPassword: PASSWORD, newPassword: "new password 123" });
    expect(ok.status).toBe(200);
    expect((await (await client.get("/api/auth/session")).json()).user.email).toBe(email);
    expect((await (await other.get("/api/auth/session")).json()).user).toBeNull();
    const x = await new Client(h.app).init();
    expect((await x.post("/api/auth/reset-password", { token: reset, password: "attacker password" })).status).toBe(400);
    expect((await x.post("/api/auth/verify", { token: magic })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Discord (no real app exists: token + /users/@me endpoints are mocked)
// ---------------------------------------------------------------------------------------------------------

const DISCORD_ENV = {
  DISCORD_CLIENT_ID: "123456",
  DISCORD_CLIENT_SECRET: "shh-secret",
  DISCORD_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/discord/callback`,
};

function discordHarness(profile: () => Record<string, unknown>, opts: { tokenStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/oauth2/token")) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response("{}", { status: opts.tokenStatus });
      return Response.json({ access_token: "discord-access-token", token_type: "Bearer", refresh_token: "discord-refresh" });
    }
    if (url.endsWith("/api/users/@me")) return Response.json(profile());
    return new Response("nope", { status: 404 });
  };
  const h = makeHarness({
    env: { WEB_PUBLIC_URL: WEB_ORIGIN, TRUST_PROXY: true, API_KEY_PEPPER: "test-pepper-0123456789abcdef", ...DISCORD_ENV },
    fetch: fetchMock,
  });
  return { ...h, calls };
}

/** Runs start → callback with the state cookie; returns the callback response. */
async function discordLogin(c: Client, query = "") {
  const start = await c.get(`/api/auth/discord${query}`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  return c.get(`/api/auth/discord/callback?code=abc&state=${state}`);
}

/** New account via Discord: callback → pending row + cookie → /signup/discord → complete (consent). */
async function discordSignup(c: Client, query = "", body: Record<string, unknown> = { consent: true }) {
  const cb = await discordLogin(c, query);
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe(`${WEB_ORIGIN}/signup/discord`);
  return c.post("/api/auth/discord/complete", body);
}

let discordIdCounter = 900000000000000000n;
const nextDiscordId = () => String(++discordIdCounter);

describe("Discord", () => {
  it("providers + 503 when not configured", async () => {
    const h = makeHarness();
    expect(await (await h.app.request("/api/auth/providers")).json()).toEqual({ discord: false });
    const r = await h.app.request("/api/auth/discord");
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("provider_not_configured");
    const d = discordHarness(() => ({}));
    expect(await (await d.app.request("/api/auth/providers")).json()).toEqual({ discord: true });
  });

  it("start: 302 to Discord with identify+email scope and a state cookie", async () => {
    const d = discordHarness(() => ({}));
    const c = await new Client(d.app).init();
    const r = await c.get("/api/auth/discord?next=/app/servers");
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(loc.searchParams.get("scope")).toBe("identify email");
    expect(loc.searchParams.get("redirect_uri")).toBe(DISCORD_ENV.DISCORD_REDIRECT_URI);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sc = r.headers.getSetCookie().find((x) => x.startsWith("td_oauth="))!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Max-Age=600/);
  });

  it("branch 1: a known Discord id logs that user in (and goes to next)", async () => {
    const id = nextDiscordId();
    const email = freshEmail("d1");
    const d = discordHarness(() => ({ id, email, verified: true, username: "d1" }));
    const c = await new Client(d.app).init();
    expect((await discordSignup(c)).status).toBe(200); // creates (branch 3)
    const c2 = await new Client(d.app).init();
    const r = await discordLogin(c2, "?next=/app/servers"); // known id: no consent needed
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/app/servers`);
    expect((await (await c2.get("/api/auth/session")).json()).user).toMatchObject({ email, discordLinked: true });
    const n = await one<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`);
    expect(n!.n).toBe(1);
  });

  it("branch 2 (L10): verified Discord email of a CONFIRMED account → no auto-link, no session, nothing written; link from the account page works", async () => {
    const d0 = makeHarness();
    const { email, id: userId } = await verifiedUser(d0);
    const id = nextDiscordId();
    const d = discordHarness(() => ({ id, email: email.toUpperCase(), verified: true, global_name: "Sam" }));
    const before = await one<{ n: number }>(sql`select (select count(*) from sessions where user_id = ${userId}) + (select count(*) from discord_pending_signups) as n`);
    const c = await new Client(d.app).init();
    const r = await discordLogin(c);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_email_exists`);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(c.cookies.has("td_discord_pending")).toBe(false);
    expect(r.headers.getSetCookie().some((x) => x.startsWith(`${SESSION_COOKIE}=`) && !/max-age=0/i.test(x))).toBe(false);
    expect(await one(sql`select 1 from oauth_accounts where provider_user_id = ${id} or user_id = ${userId}`)).toBeUndefined();
    const after = await one<{ n: number }>(sql`select (select count(*) from sessions where user_id = ${userId}) + (select count(*) from discord_pending_signups) as n`);
    expect(Number(after!.n)).toBe(Number(before!.n));
    expect((await (await c.get("/api/auth/session")).json()).user).toBeNull();

    // The owner signs in normally and links Discord from /app/account; then Discord sign-in logs them in.
    const owner = new Client(d.app);
    await owner.init();
    expect((await owner.post("/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
    expect((await discordLogin(owner, "?link=1")).headers.get("location")).toBe(`${WEB_ORIGIN}/app/account`);
    const link = await one<Record<string, unknown>>(sql`select * from oauth_accounts where provider_user_id = ${id}`);
    expect(link).toMatchObject({ user_id: userId });
    expect(Object.keys(link!).sort()).toEqual(["created_at", "id", "provider", "provider_user_id", "user_id"]);
    expect(JSON.stringify(link)).not.toContain("discord-access-token");
    const c2 = await new Client(d.app).init();
    expect((await discordLogin(c2)).headers.get("location")).toBe(`${WEB_ORIGIN}/app`);
    expect((await (await c2.get("/api/auth/session")).json()).user).toMatchObject({ id: userId, discordLinked: true, hasPassword: true });
  });

  it("branch 3: verified Discord email, no account → pending signup; consent on /signup/discord creates + links", async () => {
    const id = nextDiscordId();
    const email = freshEmail("d3");
    const d = discordHarness(() => ({ id, email, verified: true, username: "newbie" }));
    const c = await new Client(d.app).init();
    const cb = await discordLogin(c);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`${WEB_ORIGIN}/signup/discord`);
    const pc = cb.headers.getSetCookie().find((x) => x.startsWith("td_discord_pending="))!;
    expect(pc).toMatch(/HttpOnly/);
    expect(pc).toMatch(/SameSite=Lax/);
    expect(pc).toMatch(/Max-Age=600/);
    // No account, no link, no session before complete.
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await userRow(email)).toBeUndefined();
    expect(await one(sql`select 1 from oauth_accounts where provider_user_id = ${id}`)).toBeUndefined();
    const pendingToken = c.cookies.get("td_discord_pending")!;
    const stored = await one<Record<string, unknown>>(sql`select * from discord_pending_signups where discord_user_id = ${id}`);
    expect(stored).toMatchObject({ email, token_hash: sha256Hex(pendingToken), next: null, used_at: null });
    expect(JSON.stringify(stored)).not.toContain(pendingToken);

    const pending = await c.get("/api/auth/discord/pending");
    expect(pending.status).toBe(200);
    expect(discordPendingResponse.parse(await pending.json())).toEqual({ email });

    d.clock.now += 60_000;
    const r = await c.post("/api/auth/discord/complete", { consent: true, displayName: "  Newbie  " });
    expect(r.status).toBe(200);
    const sr = sessionResponse.parse(await r.json());
    expect(sr.next).toBe("/app/onboarding");
    expect(sr.user).toMatchObject({ email, emailVerified: true, hasPassword: false, discordLinked: true, displayName: "Newbie" });
    expect(new Date((await userRow(email))!.consent_at!).getTime()).toBe(d.clock.now);
    expect(c.cookies.has("td_discord_pending")).toBe(false); // cleared on success
    expect((await (await c.get("/api/auth/session")).json()).user).toMatchObject({ email, discordLinked: true });
    expect((await c.get("/api/auth/discord/pending")).status).toBe(404);
    // The token request used the code; nothing token-like is stored anywhere.
    expect(d.calls[0]!.init!.body).toContain("code=abc");
    const dump = JSON.stringify(await handle.db.execute(sql`select * from oauth_accounts`)) + JSON.stringify(await handle.db.execute(sql`select * from users`));
    expect(dump).not.toMatch(/discord-access-token|discord-refresh/);
  });

  it("branch 4: unverified Discord email → no login, /login?error=discord_email", async () => {
    const id = nextDiscordId();
    const d = discordHarness(() => ({ id, email: freshEmail("d4"), verified: false }));
    const c = await new Client(d.app).init();
    const r = await discordLogin(c);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_email`);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("branch 3b (M7): an UNCONFIRMED local row counts as no user → pending signup; complete (consent) takes it over", async () => {
    const local = freshEmail("d4local");
    const d = discordHarness(() => ({ id: nextDiscordId(), email: local, verified: true }));
    const signup = await new Client(d.app).init();
    await signup.post("/api/auth/signup", { email: local }); // unconfirmed
    const { id: uid } = (await userRow(local))!;
    const c = await new Client(d.app).init();
    const r = await discordLogin(c);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/signup/discord`);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await one(sql`select 1 from oauth_accounts where user_id = ${uid}`)).toBeUndefined(); // nothing linked yet
    expect((await userRow(local))!.verified).toBe(false);
    const done = await c.post("/api/auth/discord/complete", { consent: true });
    expect(done.status).toBe(200);
    expect(sessionResponse.parse(await done.json()).user).toMatchObject({ id: uid, emailVerified: true, discordLinked: true });
  });

  it("branch 4b: verified local account already linked to another Discord id → /login?error=discord_email_exists, no session", async () => {
    const d0 = makeHarness();
    const { email, id: userId } = await verifiedUser(d0);
    const first = nextDiscordId();
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${first}, ${userId})`);
    const d = discordHarness(() => ({ id: nextDiscordId(), email, verified: true }));
    const c = await new Client(d.app).init();
    const r = await discordLogin(c);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_email_exists`);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("state mismatch, missing state cookie and Discord errors → /login?error=discord_failed", async () => {
    const d = discordHarness(() => ({ id: nextDiscordId(), email: freshEmail(), verified: true }));
    const c = await new Client(d.app).init();
    await c.get("/api/auth/discord");
    const r1 = await c.get(`/api/auth/discord/callback?code=abc&state=${"x".repeat(43)}`);
    expect(r1.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_failed`);
    const r2 = await new Client(d.app).get(`/api/auth/discord/callback?code=abc&state=${"x".repeat(43)}`);
    expect(r2.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_failed`);
    const bad = discordHarness(() => ({}), { tokenStatus: 400 });
    const c3 = await new Client(bad.app).init();
    expect((await discordLogin(c3)).headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_failed`);
    expect(bad.logs.some((l) => l.includes("discord callback failed"))).toBe(true);
  });

  it("link from /app/account: links the signed-in user; an id linked to someone else is refused", async () => {
    const id = nextDiscordId();
    const d = discordHarness(() => ({ id, email: "unrelated@discord.test", verified: false }));
    const { client, id: userId } = await verifiedUser(d);
    const r = await discordLogin(client, "?link=1");
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/app/account`);
    expect((await (await client.get("/api/auth/session")).json()).user).toMatchObject({ id: userId, discordLinked: true });

    const { client: other } = await verifiedUser(d);
    const r2 = await discordLogin(other, "?link=1");
    expect(r2.headers.get("location")).toBe(`${WEB_ORIGIN}/app/account?error=discord_in_use`);

    const anon = await new Client(d.app).init();
    const r3 = await anon.get("/api/auth/discord?link=1");
    expect(r3.headers.get("location")).toBe(`${WEB_ORIGIN}/login?next=%2Fapp%2Faccount`);
  });
});

describe("L1 + L7: Discord edge cases", () => {
  it("link mode: the signed-in user changed before the callback → /app/account?error=discord_failed", async () => {
    const d = discordHarness(() => ({ id: nextDiscordId(), email: "x@discord.test", verified: true }));
    const a = await verifiedUser(d);
    const b = await verifiedUser(d);
    const start = await a.client.get("/api/auth/discord?link=1");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await a.client.post("/api/auth/login", { email: b.email, password: PASSWORD }); // now signed in as B
    const r = await a.client.get(`/api/auth/discord/callback?code=abc&state=${state}`);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/app/account?error=discord_failed`);
    expect(await one(sql`select 1 from oauth_accounts where user_id in (${a.id}, ${b.id})`)).toBeUndefined();
  });

  it("account creation racing another creation for the same email → no 500, one account", async () => {
    const id = nextDiscordId();
    const email = freshEmail("race");
    const d = discordHarness(() => ({ id, email, verified: true }));
    const clients = await Promise.all([new Client(d.app).init(), new Client(d.app).init(), new Client(d.app).init()]);
    // Each client gets its own pending row (sequential callbacks: a newer one drops older unused rows of the same id,
    // so seed them directly), then all complete at once.
    for (const c of clients) {
      const token = randomToken();
      await handle.db.execute(sql`insert into discord_pending_signups (token_hash, discord_user_id, email, expires_at)
        values (${sha256Hex(token)}, ${id}, ${email}, ${new Date(d.clock.now + 600_000).toISOString()}::timestamptz)`);
      c.cookies.set("td_discord_pending", token);
    }
    const res = await Promise.all(clients.map((c) => c.post("/api/auth/discord/complete", { consent: true })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    for (const r of res) if (r.status === 400) expect((await r.json()).error.code).toBe("invalid_token");
    expect((await one<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`))!.n).toBe(1);
  });

  it("isUniqueViolation recognises a real Postgres 23505 through drizzle", async () => {
    const email = freshEmail("dup");
    await ensureUser(handle.db, email);
    const err = await handle.db.execute(sql`insert into users (email) values (${email})`).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error("nope"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Re-review fixes (contract b0964f3)
// ---------------------------------------------------------------------------------------------------------

describe("confirm step: consent + name, oauth cleanup, stale tokens", () => {
  const h = makeHarness();

  it("verify (confirm) needs consent: true (400 fields.consent, token kept); sets consent_at = now and the name", async () => {
    const email = freshEmail();
    await signup(h, email);
    const token = tokenFrom(h.mailer.last(email)!.text);
    expect((await userRow(email))!.consent_at).toBeNull(); // nothing recorded before the password page
    const c = await new Client(h.app).init();
    const r = await c.post("/api/auth/verify", { token, password: PASSWORD });
    expect(r.status).toBe(400);
    expect((await r.json()).error.fields).toEqual({ consent: expect.any(String) });
    const both = await c.post("/api/auth/verify", { token });
    expect(Object.keys((await both.json()).error.fields).sort()).toEqual(["consent", "password"]);
    expect((await c.get(`/api/auth/verify-token?token=${token}`)).status).toBe(200); // not consumed

    h.clock.now += 60_000;
    const ok = await c.post("/api/auth/verify", { token, password: PASSWORD, consent: true, displayName: "  Robin  " });
    expect(ok.status).toBe(200);
    expect(sessionResponse.parse(await ok.json()).user).toMatchObject({ displayName: "Robin" });
    const row = (await userRow(email))!;
    expect(new Date(row.consent_at!).getTime()).toBe(h.clock.now);
  });

  it("confirm without a name leaves display_name null", async () => {
    const email = freshEmail();
    await signup(h, email);
    const c = await new Client(h.app).init();
    const ok = await c.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)!.text), password: PASSWORD, consent: true });
    expect(sessionResponse.parse(await ok.json()).user?.displayName).toBeNull();
  });

  it("confirm removes oauth links of the pending user", async () => {
    const email = freshEmail();
    await signup(h, email);
    const { id } = (await userRow(email))!;
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${"8" + Date.now()}, ${id})`);
    const c = await new Client(h.app).init();
    expect((await c.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)!.text), password: PASSWORD, consent: true })).status).toBe(200);
    expect(await one(sql`select 1 from oauth_accounts where user_id = ${id}`)).toBeUndefined();
  });

  it("`next` stored with the token is returned by /verify", async () => {
    const email = freshEmail();
    await signup(h, email, { next: "/app/servers/abc" });
    const c = await new Client(h.app).init();
    const v = await c.post("/api/auth/verify", { token: tokenFrom(h.mailer.last(email)!.text), password: PASSWORD, consent: true });
    expect(sessionResponse.parse(await v.json()).next).toBe("/app/servers/abc");
  });

  it("a confirm token of an already confirmed user is refused (verify-token + verify), nothing changes", async () => {
    const { email, id } = await verifiedUser(h);
    const token = await issueEmailToken(handle.db, id, "verify", h.clock.now);
    const before = await userRow(email);
    const c = await new Client(h.app).init();
    expect((await c.get(`/api/auth/verify-token?token=${token}`)).status).toBe(400);
    const r = await c.post("/api/auth/verify", { token, password: "attacker password", consent: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_token");
    expect(await userRow(email)).toEqual(before);
  });

  it("magic/reset tokens inserted for an unconfirmed user are refused by verify-token, verify and reset-password", async () => {
    const email = freshEmail("pending");
    await signup(h, email);
    const { id } = (await userRow(email))!;
    const magic = await issueEmailToken(handle.db, id, "magic", h.clock.now);
    const reset = await issueEmailToken(handle.db, id, "reset", h.clock.now);
    const c = await new Client(h.app).init();
    expect((await c.get(`/api/auth/verify-token?token=${magic}`)).status).toBe(400);
    expect((await c.post("/api/auth/verify", { token: magic })).status).toBe(400);
    expect((await c.get(`/api/auth/verify-token?token=${reset}`)).status).toBe(400);
    expect((await c.post("/api/auth/reset-password", { token: reset, password: "brand new password" })).status).toBe(400);
    const row = (await userRow(email))!;
    expect(row).toMatchObject({ verified: false, password_hash: null });
    expect(await sessionCount(id)).toBe(0);
  });

  it("two concurrent confirms with different passwords: one 200, one 400, the stored hash is the winner's", async () => {
    const email = freshEmail();
    await signup(h, email);
    const token = tokenFrom(h.mailer.last(email)!.text);
    const a = await new Client(h.app).init();
    const b = await new Client(h.app).init();
    const [ra, rb] = await Promise.all([
      a.post("/api/auth/verify", { token, password: "password number A", consent: true }),
      b.post("/api/auth/verify", { token, password: "password number B", consent: true }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 400]);
    const winner = ra.status === 200 ? "password number A" : "password number B";
    const loser = ra.status === 200 ? "password number B" : "password number A";
    const hash = (await userRow(email))!.password_hash!;
    expect(await verifyPassword(winner, hash)).toBe(true);
    expect(await verifyPassword(loser, hash)).toBe(false);
    expect((await (ra.status === 200 ? rb : ra).json()).error.code).toBe("invalid_token");
  });
});

describe("pending-user purge (hourly job)", () => {
  it("deletes pending users without servers 7 days after their last signup; keeps the rest", async () => {
    const h = makeHarness();
    const day = 86_400_000;
    const base = h.clock.now;
    const old = freshEmail("old");
    const refreshed = freshEmail("refreshed");
    const recent = freshEmail("recent");
    await signup(h, old);
    await signup(h, refreshed);
    const { id: oldId } = (await userRow(old))!;
    h.clock.now = base + 6 * day;
    await signup(h, refreshed); // re-signup refreshes last_signup_at
    await signup(h, recent);
    // CLI-created unconfirmed owner of a server (created long ago) and an old confirmed user without servers.
    const cli = await createServer(handle.db, "test-pepper-0123456789abcdef", { name: "Kept", ownerEmail: freshEmail("cliowner") });
    await handle.db.execute(sql`update users set created_at = ${new Date(base - 30 * day).toISOString()}::timestamptz where id = ${cli.ownerId}`);
    const { email: confirmed, id: confirmedId } = await verifiedUser(h);
    await handle.db.execute(sql`update users set created_at = ${new Date(base - 30 * day).toISOString()}::timestamptz where id = ${confirmedId}`);

    const n = await purgePendingUsers(handle.db, base + 7 * day + 1000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await userRow(old)).toBeUndefined();
    expect(await one(sql`select 1 from email_tokens where user_id = ${oldId}`)).toBeUndefined();
    expect(await userRow(refreshed)).toBeTruthy();
    expect(await userRow(recent)).toBeTruthy();
    expect(await one(sql`select 1 from users where id = ${cli.ownerId}`)).toBeTruthy();
    expect(await userRow(confirmed)).toBeTruthy();
  });
});

describe("migrations 0006/0007 data effects", () => {
  it("unconfirmed users lose password, sessions, oauth links and magic/reset tokens; confirmed users keep theirs", async () => {
    const h = makeHarness();
    const pendingEmail = freshEmail("mig");
    await signup(h, pendingEmail);
    const { id: pid } = (await userRow(pendingEmail))!;
    const { email: confirmedEmail, id: cid } = await verifiedUser(h);
    const hash = await hashPassword("legacy password!");
    const seed = async (uid: string, tag: string) => {
      await handle.db.execute(sql`update users set password_hash = ${hash} where id = ${uid}`);
      await handle.db.execute(sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256Hex(randomToken())}, ${uid}, now() + interval '1 day')`);
      await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${tag + Date.now()}, ${uid})`);
      for (const kind of ["magic", "reset", "verify"]) {
        await handle.db.execute(sql`insert into email_tokens (token_hash, kind, user_id, expires_at) values (${sha256Hex(randomToken())}, ${kind}, ${uid}, now() + interval '1 hour')`);
      }
    };
    await seed(pid, "91");
    await seed(cid, "92");

    for (const file of ["0006_phase5_confirm_model.sql", "0007_phase5_pending_cleanup.sql"]) {
      const text = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
      for (const stmt of text.split("--> statement-breakpoint")) {
        const body = stmt.replace(/^\s*--.*$/gm, "").trim();
        if (/^(UPDATE|DELETE)\b/i.test(body)) await handle.db.execute(sql.raw(body));
      }
    }
    const state = async (uid: string) =>
      one<{ pw: boolean; s: number; o: number; kinds: string }>(sql`select
        (select password_hash is not null from users where id = ${uid}) as pw,
        (select count(*)::int from sessions where user_id = ${uid}) as s,
        (select count(*)::int from oauth_accounts where user_id = ${uid}) as o,
        (select string_agg(distinct kind, ',' order by kind) from email_tokens where user_id = ${uid}) as kinds`);
    expect(await state(pid)).toEqual({ pw: false, s: 0, o: 0, kinds: "verify" });
    const c = await state(cid);
    expect(c).toMatchObject({ pw: true, o: 1, kinds: "magic,reset,verify" });
    expect(c!.s).toBeGreaterThanOrEqual(2);
    expect((await userRow(pendingEmail))!.verified).toBe(false);
    expect((await userRow(confirmedEmail))!.verified).toBe(true);
  });
});

describe("Discord: linked but unconfirmed (pre-0007 data)", () => {
  it("a known Discord id whose user is unconfirmed → /login?error=discord_email, no session", async () => {
    const id = nextDiscordId();
    const email = freshEmail("linkedpending");
    const d = discordHarness(() => ({ id, email, verified: true }));
    await signup(d, email);
    const { id: uid } = (await userRow(email))!;
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${id}, ${uid})`);
    const c = await new Client(d.app).init();
    const r = await discordLogin(c);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${WEB_ORIGIN}/login?error=discord_email`);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await sessionCount(uid)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Pending Discord signup → /signup/discord consent → complete (contract 38dc933)
// ---------------------------------------------------------------------------------------------------------

describe("Discord pending signup + complete", () => {
  const setup = async (extra: Record<string, unknown> = {}) => {
    const id = nextDiscordId();
    const email = freshEmail("dp");
    const d = discordHarness(() => ({ id, email, verified: true, username: "pend", ...extra }));
    const c = await new Client(d.app).init();
    return { id, email, d, c };
  };
  const pendingRow = (id: string) =>
    one<{ used_at: Date | null; next: string | null }>(sql`select used_at, next from discord_pending_signups where discord_user_id = ${id} order by created_at desc limit 1`);

  it("start no longer takes consent=1; next from the start request is kept and returned by complete", async () => {
    const { c, id } = await setup();
    const start = await c.get("/api/auth/discord?next=/app/servers&consent=1");
    const raw = c.cookies.get("td_oauth")!;
    expect(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))).not.toHaveProperty("c");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await c.get(`/api/auth/discord/callback?code=abc&state=${state}`);
    expect(cb.headers.get("location")).toBe(`${WEB_ORIGIN}/signup/discord`);
    expect((await pendingRow(id))!.next).toBe("/app/servers");
    const r = await c.post("/api/auth/discord/complete", { consent: true });
    const sr = sessionResponse.parse(await r.json());
    expect(sr.next).toBe("/app/servers");
    expect(sr.user!.displayName).toBeNull();
  });

  it("missing/false consent → 400 fields.consent, the pending row stays usable, no account", async () => {
    const { c, id, email } = await setup();
    expect((await discordLogin(c)).headers.get("location")).toBe(`${WEB_ORIGIN}/signup/discord`);
    for (const body of [{}, { consent: false }, { displayName: "x" }]) {
      const r = await c.post("/api/auth/discord/complete", body);
      expect(r.status).toBe(400);
      const b = await r.json();
      expect(b.error.code).toBe("invalid_request");
      expect(b.error.fields.consent).toBeTruthy();
    }
    expect(await userRow(email)).toBeUndefined();
    expect((await pendingRow(id))!.used_at).toBeNull();
    expect((await c.get("/api/auth/discord/pending")).status).toBe(200);
    expect((await c.post("/api/auth/discord/complete", { consent: true })).status).toBe(200);
  });

  it("expires after 10 min: pending → 404, complete → 400 invalid_token, nothing created", async () => {
    const { c, d, email } = await setup();
    await discordLogin(c);
    d.clock.now += 10 * 60_000 + 1;
    const p = await c.get("/api/auth/discord/pending");
    expect(p.status).toBe(404);
    expect((await p.json()).error.code).toBe("not_found");
    const r = await c.post("/api/auth/discord/complete", { consent: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_token");
    expect(await userRow(email)).toBeUndefined();
  });

  it("no / unknown cookie: pending → 404, complete → 400 invalid_token", async () => {
    const { d } = await setup();
    const c = await new Client(d.app).init();
    expect((await c.get("/api/auth/discord/pending")).status).toBe(404);
    expect((await (await c.post("/api/auth/discord/complete", { consent: true })).json()).error.code).toBe("invalid_token");
    c.cookies.set("td_discord_pending", randomToken());
    expect((await c.get("/api/auth/discord/pending")).status).toBe(404);
    expect((await c.post("/api/auth/discord/complete", { consent: true })).status).toBe(400);
  });

  it("single use: replaying the cookie after success → 400 invalid_token, still one account", async () => {
    const { c, d, email } = await setup();
    await discordLogin(c);
    const token = c.cookies.get("td_discord_pending")!;
    expect((await c.post("/api/auth/discord/complete", { consent: true })).status).toBe(200);
    const replay = await new Client(d.app).init();
    replay.cookies.set("td_discord_pending", token);
    const r = await replay.post("/api/auth/discord/complete", { consent: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_token");
    expect(replay.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await one<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`))!.n).toBe(1);
  });

  it("email of a pending signup meanwhile → that row is taken over: confirmed, tokens voided, sessions/oauth cleared, linked", async () => {
    const { c, d, id, email } = await setup();
    await discordLogin(c);
    await signup(d, email); // pending local signup appears in between (maybe by someone else)
    const { id: uid } = (await userRow(email))!;
    const link = tokenFrom(d.mailer.last(email)!.text);
    // Leftovers that must not survive (pre-seeded: legacy data).
    await handle.db.execute(sql`update users set password_hash = ${await hashPassword("leftover password")} where id = ${uid}`);
    await handle.db.execute(sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256Hex(randomToken())}, ${uid}, now() + interval '1 day')`);
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${nextDiscordId()}, ${uid})`);
    d.clock.now += 1000;
    const r = await c.post("/api/auth/discord/complete", { consent: true, displayName: "Owner" });
    expect(r.status).toBe(200);
    const sr = sessionResponse.parse(await r.json());
    expect(sr.user).toMatchObject({ id: uid, email, emailVerified: true, hasPassword: false, discordLinked: true, displayName: "Owner" });
    const row = (await userRow(email))!;
    expect(row).toMatchObject({ id: uid, verified: true, password_hash: null, display_name: "Owner" });
    expect(new Date(row.consent_at!).getTime()).toBe(d.clock.now);
    expect(await one(sql`select 1 from email_tokens where user_id = ${uid}`)).toBeUndefined();
    const links = (await handle.db.execute(sql`select provider_user_id from oauth_accounts where user_id = ${uid}`)) as unknown as { provider_user_id: string }[];
    expect(links.map((x) => x.provider_user_id)).toEqual([id]);
    expect(await sessionCount(uid)).toBe(1); // only the new login
    expect((await one<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`))!.n).toBe(1);
    // The emailed confirm link is dead now.
    const other = await new Client(d.app).init();
    expect((await other.get(`/api/auth/verify-token?token=${link}`)).status).toBe(400);
    expect((await other.post("/api/auth/verify", { token: link, password: "attacker password", consent: true })).status).toBe(400);
  });

  it("CLI-created unconfirmed user owning servers → taken over, keeps its servers", async () => {
    const { c, id, email } = await setup();
    await discordLogin(c);
    const srv = await createServer(handle.db, "test-pepper-0123456789abcdef", { name: "CLI box", ownerEmail: email });
    expect((await userRow(email))!.verified).toBe(false);
    const r = await c.post("/api/auth/discord/complete", { consent: true });
    expect(r.status).toBe(200);
    const sr = sessionResponse.parse(await r.json());
    expect(sr.user).toMatchObject({ id: srv.ownerId, emailVerified: true, discordLinked: true, displayName: null });
    expect(await one(sql`select 1 from servers where id = ${srv.serverId} and owner_id = ${srv.ownerId}`)).toBeTruthy();
    expect(await one(sql`select 1 from oauth_accounts where provider_user_id = ${id} and user_id = ${srv.ownerId}`)).toBeTruthy();
    expect((await c.get("/api/servers")).status).toBe(200);
  });

  it("email of a CONFIRMED user meanwhile → 400 invalid_token, row consumed, that user untouched", async () => {
    const { c, d, id } = await setup();
    await discordLogin(c);
    const email = (await one<{ email: string }>(sql`select email from discord_pending_signups where discord_user_id = ${id}`))!.email;
    await signup(d, email);
    const confirm = await new Client(d.app).init();
    expect((await confirm.post("/api/auth/verify", { token: tokenFrom(d.mailer.last(email)!.text), password: PASSWORD, consent: true })).status).toBe(200);
    const before = await userRow(email);
    const r = await c.post("/api/auth/discord/complete", { consent: true, displayName: "Hijack" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_token");
    expect(await userRow(email)).toEqual(before);
    expect(await one(sql`select 1 from oauth_accounts where provider_user_id = ${id}`)).toBeUndefined();
    expect((await pendingRow(id))!.used_at).not.toBeNull();
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("Discord id linked meanwhile → 400 invalid_token, no account created (rolled back), row consumed", async () => {
    const { c, d, id, email } = await setup();
    await discordLogin(c);
    const other = await verifiedUser(d);
    await handle.db.execute(sql`insert into oauth_accounts (provider, provider_user_id, user_id) values ('discord', ${id}, ${other.id})`);
    const r = await c.post("/api/auth/discord/complete", { consent: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("invalid_token");
    expect(await userRow(email)).toBeUndefined();
    expect((await pendingRow(id))!.used_at).not.toBeNull();
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("complete needs CSRF (Origin + token); the row stays usable after a refused request", async () => {
    const { c, id, email } = await setup();
    await discordLogin(c);
    for (const r of [
      await c.req("POST", "/api/auth/discord/complete", { consent: true }, { csrf: false }),
      await c.req("POST", "/api/auth/discord/complete", { consent: true }, { origin: "https://evil.example" }),
      await c.req("POST", "/api/auth/discord/complete", { consent: true }, { origin: null }),
    ]) {
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("csrf_failed");
    }
    expect(await userRow(email)).toBeUndefined();
    expect((await pendingRow(id))!.used_at).toBeNull();
  });

  it("complete is rate limited per IP (tokenPerIp)", async () => {
    const { d } = await setup();
    const c = await new Client(d.app).init();
    let last = 0;
    for (let i = 0; i < AUTH_LIMITS.tokenAttemptsPerIpPer15Min + 1; i++) last = (await c.post("/api/auth/discord/complete", { consent: true })).status;
    expect(last).toBe(429);
  });

  it("a newer Discord callback for the same id replaces the older pending row", async () => {
    const { d, id } = await setup();
    const a = await new Client(d.app).init();
    const b = await new Client(d.app).init();
    await discordLogin(a);
    await discordLogin(b);
    expect((await one<{ n: number }>(sql`select count(*)::int as n from discord_pending_signups where discord_user_id = ${id}`))!.n).toBe(1);
    expect((await a.post("/api/auth/discord/complete", { consent: true })).status).toBe(400);
    expect((await b.post("/api/auth/discord/complete", { consent: true })).status).toBe(200);
  });

  it("hourly auth purge removes expired and used pending rows, keeps live ones", async () => {
    const { d, id } = await setup();
    const live = await new Client(d.app).init();
    await discordLogin(live);
    const now = d.clock.now;
    const ins = (tag: string, expires: number, used: boolean) =>
      handle.db.execute(sql`insert into discord_pending_signups (token_hash, discord_user_id, email, expires_at, used_at)
        values (${sha256Hex(randomToken())}, ${tag}, ${freshEmail("purge")}, ${new Date(expires).toISOString()}::timestamptz,
                ${used ? new Date(now).toISOString() : null}::timestamptz)`);
    const expiredId = nextDiscordId();
    const usedId = nextDiscordId();
    await ins(expiredId, now - 1000, false);
    await ins(usedId, now + 60_000, true);
    const r = await purgeExpiredAuth(handle.db, now);
    expect(r.discordPending).toBeGreaterThanOrEqual(2);
    const left = (await handle.db.execute(sql`select discord_user_id from discord_pending_signups where discord_user_id in (${id}, ${expiredId}, ${usedId})`)) as unknown as { discord_user_id: string }[];
    expect(left.map((x) => x.discord_user_id)).toEqual([id]);
  });
});
