import { z } from "zod";
import { RECHECK_DEFAULTS } from "@tickdoctor/shared";
import { parseSecretsKey } from "./alerts/crypto.js";

const isSecretsKey = (v: string) => {
  try {
    parseSecretsKey(v);
    return true;
  } catch {
    return false;
  }
};

const envNodeEnv = z.enum(["development", "test", "production"]).default("development");

const boolString = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

/** Shared by the API env and the CLI (cli.ts), so both accept exactly the same peppers. */
export const apiKeyPepperSchema = z.string().min(16, "must be at least 16 characters");
const PEPPER_PLACEHOLDER = /change-?me/i;
const PEPPER_PLACEHOLDER_MSG = "placeholder value; set a random secret when NODE_ENV=production";

/** Validates API_KEY_PEPPER like loadEnv does (length; no placeholder in production). Throws. */
export function parsePepper(source: Record<string, string | undefined> = process.env): string {
  const parsed = z
    .object({ NODE_ENV: envNodeEnv, API_KEY_PEPPER: apiKeyPepperSchema })
    .superRefine((e, ctx) => {
      if (e.NODE_ENV === "production" && PEPPER_PLACEHOLDER.test(e.API_KEY_PEPPER)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["API_KEY_PEPPER"], message: PEPPER_PLACEHOLDER_MSG });
      }
    })
    .safeParse(source);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "API_KEY_PEPPER"}: ${i.message}`).join("; "));
  }
  return parsed.data.API_KEY_PEPPER;
}

/** BETA_ALL_PRO like loadEnv parses it (the CLI applies the same switch as the API). Throws on bad values. */
export function parseBetaAllPro(source: Record<string, string | undefined> = process.env): boolean {
  const parsed = z.object({ BETA_ALL_PRO: boolString }).safeParse(source);
  if (!parsed.success) throw new Error("BETA_ALL_PRO: must be true, false, 1, 0 or empty");
  return parsed.data.BETA_ALL_PRO;
}

/**
 * Findings recheck windows (contracts §6.4). Defaults = RECHECK_DEFAULTS; shorter values are for tests and live
 * checks (e.g. FINDING_RECHECK_SERVER_MINUTES=2 to watch a fix get confirmed quickly).
 */
const recheckEnvShape = {
  FINDING_RECHECK_INCIDENT_HOURS: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().positive().max(24 * 365).default(RECHECK_DEFAULTS.incidentScopeHours),
  ),
  FINDING_RECHECK_SERVER_MINUTES: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().positive().max(24 * 60 * 30).default(RECHECK_DEFAULTS.serverScopeMinutes),
  ),
};

export interface RecheckConfig {
  incidentHours: number;
  serverMinutes: number;
}

/** Recheck windows from the environment (used by the API and the CLI). Throws on bad values. */
export function parseRecheck(source: Record<string, string | undefined> = process.env): RecheckConfig {
  const parsed = z.object(recheckEnvShape).safeParse(source);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return {
    incidentHours: parsed.data.FINDING_RECHECK_INCIDENT_HOURS,
    serverMinutes: parsed.data.FINDING_RECHECK_SERVER_MINUTES,
  };
}

const optStr = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(1000).optional());

const envSchema = z
  .object({
    NODE_ENV: envNodeEnv,
    DATABASE_URL: z.string().url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Interface to bind; 0.0.0.0 so Caddy (or the Pi over Tailscale) can reach it. */
    API_HOST: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).default("0.0.0.0")),
    /** Exact origin the browser sends for the landing page (scheme://host[:port], no trailing slash). */
    WEB_PUBLIC_URL: z
      .string()
      .url()
      .transform((u) => new URL(u).origin),
    /** Only set to true when the API sits behind a trusted proxy (Caddy in docker-compose). */
    TRUST_PROXY: boolString,
    /** Defence in depth: max NEW waitlist rows per rolling hour across all clients. */
    WAITLIST_GLOBAL_CAP_PER_HOUR: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(1).max(100_000).default(200),
    ),
    /** Server-side pepper mixed into API-key hashes: sha256(key + pepper). Changing it invalidates every key. */
    API_KEY_PEPPER: apiKeyPepperSchema,
    /** Mounts GET /v1/debug/last (the caller's own recent ingest payloads, in memory). Dev only. */
    INGEST_DEBUG: boolString,
    /** Phase 8: every account gets Pro limits (stored plans untouched); applied only in limits.ts (effectivePlan). */
    BETA_ALL_PRO: boolString,
    /** Phase 3 dev-only bearer token for GET /api/servers/:id/metrics (Phase 5 replaces it with sessions). */
    DEV_ADMIN_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32).max(512).optional()),
    ...recheckEnvShape,
    /** Secure flag on td_session / td_csrf / td_oauth. Empty → true in production, false otherwise. */
    COOKIE_SECURE: z.enum(["true", "false", "1", "0", ""]).default(""),
    /** SMTP for auth emails (Mailpit in dev). Empty SMTP_HOST → emails are only logged (subject + recipient domain). */
    SMTP_HOST: optStr,
    SMTP_PORT: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(1).max(65535).default(1025)),
    SMTP_USER: optStr,
    SMTP_PASSWORD: optStr,
    /** true = implicit TLS (port 465). STARTTLS is used automatically when the server offers it. */
    SMTP_SECURE: boolString,
    MAIL_FROM: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(3).max(200).optional()),
    /** api-url written into the agent config snippet (default WEB_PUBLIC_URL). */
    AGENT_API_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    /** Directory with tickdoctor-agent-<semver>.jar files served by GET /downloads/agent/latest.jar. */
    AGENT_JAR_DIR: optStr,
    /** Discord OAuth (optional): all three set → enabled. Redirect = <WEB_PUBLIC_URL>/api/auth/discord/callback. */
    DISCORD_CLIENT_ID: optStr,
    DISCORD_CLIENT_SECRET: optStr,
    DISCORD_REDIRECT_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    /**
     * Phase 6: AES-256-GCM key for secrets at rest (Discord alert webhook URLs). 32 bytes, base64
     * (`openssl rand -base64 32`). Optional: without it alert webhooks can't be saved. Changing it makes saved
     * webhooks unreadable (owners paste them again).
     */
    SECRETS_KEY: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .optional()
        .refine((v) => v === undefined || isSecretsKey(v), "must be 32 bytes, base64 (generate: openssl rand -base64 32)"),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (PEPPER_PLACEHOLDER.test(env.API_KEY_PEPPER)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["API_KEY_PEPPER"], message: PEPPER_PLACEHOLDER_MSG });
    }
    if (env.COOKIE_SECURE === "false" || env.COOKIE_SECURE === "0") {
      // Session / CSRF cookies without Secure would be sent over plain HTTP; production is HTTPS-only.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: "must not be false when NODE_ENV=production (leave empty or set true)",
      });
    }
    const devOnly = [
      ["INGEST_DEBUG", env.INGEST_DEBUG],
      ["DEV_ADMIN_TOKEN", env.DEV_ADMIN_TOKEN !== undefined],
    ] as const;
    for (const [name, set] of devOnly) {
      if (set) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "dev-only setting; must be unset (or false) when NODE_ENV=production",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** COOKIE_SECURE resolved: explicit true/false wins; empty → true only in production. */
export function cookieSecure(env: Pick<Env, "COOKIE_SECURE" | "NODE_ENV">): boolean {
  if (env.COOKIE_SECURE === "true" || env.COOKIE_SECURE === "1") return true;
  if (env.COOKIE_SECURE === "false" || env.COOKIE_SECURE === "0") return false;
  return env.NODE_ENV === "production";
}

/** Parses and validates the environment. Throws (fail fast) listing every bad variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
