import { Hono, type Context } from "hono";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { putStatusPageRequest } from "@tickdoctor/shared";
import type { Db } from "../db/client.js";
import { rows } from "../db/query.js";
import { HttpError, errorBody } from "../errors.js";
import { bodyLimit } from "../middleware/body-limit.js";
import type { ClientIpResolver } from "../middleware/client-ip.js";
import { rateLimited, type RateLimitStore } from "../middleware/rate-limit.js";
import type { SessionEnv } from "../middleware/session.js";
import { canHideBranding, loadSettings, saveSettings, slugProblem, stripControls, withUrls } from "../status-pages/settings.js";
import { buildPublicStatus, findPublicPage } from "../status-pages/public.js";
import { statusBadge, unknownBadge } from "../status-pages/badge.js";
import { serverAccess } from "./servers.js";
import { MAX_JSON_BYTES, readJson } from "./json.js";

// Phase 7 (contract app-phase7.ts): status page settings (owner), public status JSON, status badge.

export interface Phase7Deps {
  db: Db;
  now: () => number;
  adminToken: string | undefined;
  /** Normalised WEB_PUBLIC_URL (origin, no trailing slash). */
  webOrigin: string;
  clientIp: ClientIpResolver;
  /** GET /api/public/status/:slug per IP (contract: 60 / min). */
  publicPerIp: RateLimitStore;
  /** GET /badge/:slug.svg per IP (not in the contract; generous, badges sit in READMEs behind image proxies). */
  badgePerIp: RateLimitStore;
}

// Slugs are lower-cased (and trimmed) before validation, so "My-Server" is accepted as "my-server". Titles lose
// control and bidi characters before the length checks.
const putBody = z.preprocess((v) => {
  if (!v || typeof v !== "object") return v;
  const o = { ...(v as Record<string, unknown>) };
  if (typeof o.slug === "string") o.slug = o.slug.trim().toLowerCase();
  if (typeof o.title === "string") o.title = stripControls(o.title);
  return o;
}, putStatusPageRequest.extend({ slug: z.string().max(200) }));

// ---------- owner: /api/servers/:id/status-page ----------

export function statusPageRoutes(deps: Phase7Deps) {
  const app = new Hono<SessionEnv>();
  app.use("*", bodyLimit(MAX_JSON_BYTES));
  const authorize = serverAccess(deps.db, deps.adminToken);

  app.get("/:id/status-page", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    const { settings } = await loadSettings(deps.db, serverId);
    return c.json(withUrls(settings, deps.webOrigin), 200);
  });

  app.put("/:id/status-page", async (c) => {
    const { serverId } = await authorize(c, c.req.param("id"));
    const body = await readJson(c, putBody);
    const problem = slugProblem(body.slug);
    if (problem) throw new HttpError(400, "invalid_request", "Please check the highlighted fields", {}, { slug: problem });
    const [s] = await rows<{ plan: string }>(deps.db, sql`select plan from servers where id = ${serverId}`);
    // Free ("branded") can't hide the branding: silently forced false (the UI explains why).
    const settings = { ...body, hideBranding: body.hideBranding && canHideBranding(s?.plan ?? "free") };
    const r = await saveSettings(deps.db, serverId, settings, deps.now());
    if (r === "slug_taken") {
      throw new HttpError(409, "conflict", "This address is already taken", {}, { slug: "This address is already taken, please pick another one" });
    }
    return c.json(withUrls((await loadSettings(deps.db, serverId)).settings, deps.webOrigin), 200);
  });

  return app;
}

// ---------- public: /api/public/status/:slug ----------

const NOT_FOUND_BODY = errorBody("not_found", "Not found");

/** Unknown slug and disabled page answer exactly the same (body, status, headers). */
const publicNotFound = (c: Context) => {
  c.header("Cache-Control", "no-store");
  return c.json(NOT_FOUND_BODY, 404);
};

/** Accepts any case; anything that can't be a slug is simply not found. */
const slugParam = (raw: string): string | null => {
  const s = raw.toLowerCase();
  return /^[a-z0-9-]{1,40}$/.test(s) ? s : null;
};

export function publicStatusRoutes(deps: Phase7Deps) {
  const app = new Hono();
  app.get("/status/:slug", async (c) => {
    const retryAfter = deps.publicPerIp.hit(deps.clientIp(c), deps.now());
    if (retryAfter > 0) throw rateLimited(retryAfter);
    const slug = slugParam(c.req.param("slug"));
    const page = slug ? await findPublicPage(deps.db, slug) : null;
    if (!page) return publicNotFound(c);
    const body = await buildPublicStatus(deps.db, page, deps.now());
    c.header("Cache-Control", "public, max-age=30");
    return c.json(body, 200);
  });
  app.all("*", (c) => publicNotFound(c));
  return app;
}

// ---------- badge: /badge/:slug.svg ----------

export function badgeRoutes(deps: Phase7Deps) {
  const app = new Hono();
  const svg = (c: Context, body: string, status: 200 | 404 | 429) => {
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", status === 429 ? "no-store" : "public, max-age=60");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(body, status);
  };
  app.get("/:file", async (c) => {
    const retryAfter = deps.badgePerIp.hit(deps.clientIp(c), deps.now());
    if (retryAfter > 0) {
      // Still an image (it sits in an <img>), status 429.
      c.header("Retry-After", String(retryAfter));
      return svg(c, unknownBadge(), 429);
    }
    const m = /^(.+)\.svg$/i.exec(c.req.param("file"));
    const slug = m ? slugParam(m[1]!) : null;
    const page = slug ? await findPublicPage(deps.db, slug) : null;
    if (!page) return svg(c, unknownBadge(), 404);
    const s = await buildPublicStatus(deps.db, { ...page, showUptime: false, showIncidents: false }, deps.now());
    return svg(c, statusBadge(s), 200);
  });
  return app;
}
