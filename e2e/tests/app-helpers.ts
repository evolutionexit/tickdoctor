import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Phase 5 helpers. Users are seeded straight into Postgres (with a real scrypt hash and a real session row) so the suites
// don't burn the in-memory signup/login rate limits (10 signups/h, 20 logins/15 min per IP) that the UI flows need.
const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, "../..");
export const BASE = "http://localhost:3000";
export const MAILPIT = "http://localhost:8025/api/v1";
export const PASSWORD = "correct horse battery";

const dcEnv = { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` };
export const sql = (q: string): string =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "tickdoctor", "-tAc", q], { cwd: repo, env: dcEnv, encoding: "utf8" }).trim();

export const uid = () => randomBytes(4).toString("hex");
export const uniqueEmail = (tag = "u") => `e2e-${tag}-${Date.now().toString(36)}${uid()}@test.local`;

const hashCache = new Map<string, string>();
/** Same format as apps/api/src/auth/crypto.ts: scrypt$log2N$r$p$salt$hash (base64). */
export function hashPassword(pw: string): string {
  const hit = hashCache.get(pw);
  if (hit) return hit;
  const salt = randomBytes(16);
  const N = 2 ** 15;
  const key = scryptSync(pw, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
  const enc = `scrypt$15$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
  hashCache.set(pw, enc);
  return enc;
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

export function seedUser(o: { email?: string; password?: string | null; verified?: boolean; plan?: string; displayName?: string } = {}): SeededUser {
  const email = o.email ?? uniqueEmail();
  const password = o.password === undefined ? PASSWORD : o.password;
  const hash = password ? `'${hashPassword(password)}'` : "null";
  const id = randomUUID();
  const name = o.displayName ? `'${o.displayName.replace(/'/g, "''")}'` : "null";
  sql(
    `insert into users (id,email,display_name,password_hash,email_verified_at,plan) values ('${id}','${email}',${name},${hash},${
      o.verified === false ? "null" : "now()"
    },'${o.plan ?? "free"}')`,
  );
  return { id, email, password: password ?? "" };
}

export function seedSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const h = createHash("sha256").update(token).digest("hex");
  sql(`insert into sessions (id_hash,user_id,expires_at) values ('${h}','${userId}', now() + interval '30 days')`);
  return token;
}

export async function contextFor(browser: Browser, user: SeededUser, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE, ...opts });
  await ctx.addCookies([{ name: "td_session", value: seedSession(user.id), url: BASE, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}

/** Test cleanup: drops the user (servers cascade or are removed first). */
export function dropUser(email: string) {
  try {
    sql(`delete from servers where owner_id in (select id from users where email='${email}')`);
  } catch {
    /* servers may cascade */
  }
  sql(`delete from users where email='${email}'`);
}

// ---------------------------------------------------------------------------------------------------------------- Mailpit
export async function waitForMail(to: string, subjectPart: string, since = 0, timeoutMs = 15_000): Promise<{ id: string; text: string; subject: string }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`);
    const j = (await r.json()) as { messages: { ID: string; Subject: string; Created: string }[] };
    const m = j.messages.find((x) => x.Subject.toLowerCase().includes(subjectPart.toLowerCase()) && Date.parse(x.Created) >= since);
    if (m) {
      const full = (await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string };
      return { id: m.ID, text: full.Text, subject: m.Subject };
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error(`no mail to ${to} with subject containing "${subjectPart}"`);
}
export async function mailLink(to: string, subjectPart: string, since = 0): Promise<string> {
  const m = await waitForMail(to, subjectPart, since);
  const link = /(https?:\/\/\S+?\/(?:verify-email|reset-password)\?\S+)/.exec(m.text)?.[1];
  if (!link) throw new Error(`no link in mail: ${m.text.slice(0, 200)}`);
  return link.replace(/[).,>]+$/, "");
}
export const mailCount = async (to: string) =>
  ((await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages: unknown[] }).messages.length;

// ---------------------------------------------------------------------------------------------------------------- app API (as a signed-in page)
export async function csrf(page: Page): Promise<string> {
  const find = async () => (await page.context().cookies(BASE)).find((x) => x.name === "td_csrf")?.value;
  const c = await find();
  if (c) return c;
  await page.request.get("/api/auth/session");
  return (await find())!;
}
export async function apiPost(page: Page, path: string, data: unknown = {}, method: "POST" | "PATCH" | "DELETE" | "PUT" = "POST") {
  const token = await csrf(page);
  return page.request.fetch(path, { method, data, headers: { origin: BASE, "x-csrf-token": token } });
}
export async function createServerApi(page: Page, name: string) {
  const r = await apiPost(page, "/api/servers", { name });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { server: { id: string; name: string }; setup: { apiKey: string; configSnippet: string } };
}

// ---------------------------------------------------------------------------------------------------------------- fake agent
const fx = (n: string) => JSON.parse(readFileSync(join(repo, `apps/api/test/fixtures/ingest/${n}.json`), "utf8"));
export const agentPost = (request: APIRequestContext, key: string, ep: "hello" | "metrics", body: unknown) =>
  request.post(`/v1/ingest/${ep}`, { headers: { Authorization: `Bearer ${key}` }, data: body });

export function helloBody(bootId = randomUUID()) {
  const b = fx("hello");
  b.bootId = bootId;
  b.sentAt = new Date().toISOString();
  return b;
}
export interface SampleOpts {
  tps?: number;
  p95?: number;
  avg?: number;
  players?: number;
  noTemp?: boolean;
  noSwap?: boolean;
  noHost?: boolean;
  ts?: Date;
}
export function metricsBody(o: SampleOpts = {}, bootId = randomUUID()) {
  const b = fx("metrics");
  const s = b.payload.samples[0];
  const ts = (o.ts ?? new Date()).toISOString();
  s.ts = ts;
  s.tick.slowTicks = [];
  if (o.tps !== undefined) s.tick.tps1m = o.tps;
  if (o.p95 !== undefined) s.tick.msptP95 = o.p95;
  if (o.avg !== undefined) s.tick.msptAvg = o.avg;
  if (o.players !== undefined) s.players.count = o.players;
  if (o.noTemp) delete s.host.cpuTempC;
  if (o.noSwap) {
    delete s.host.swapUsedBytes;
    delete s.host.swapTotalBytes;
  }
  if (o.noHost) delete s.host;
  b.payload.samples = [s];
  b.sentAt = ts;
  b.bootId = bootId;
  return b;
}
/** Pushes hello + one metrics sample as the fake agent. */
export async function pushData(request: APIRequestContext, key: string, o: SampleOpts = {}) {
  const boot = randomUUID();
  const h = await agentPost(request, key, "hello", helloBody(boot));
  expect(h.status(), await h.text()).toBeLessThan(300);
  const m = await agentPost(request, key, "metrics", metricsBody(o, boot));
  expect(m.status(), await m.text()).toBeLessThan(300);
  return boot;
}

export async function uiLogin(page: Page, email: string, password: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}
