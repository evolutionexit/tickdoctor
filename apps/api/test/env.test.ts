import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("loadEnv", () => {
  it("fails fast on missing required variables", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("normalises WEB_PUBLIC_URL to an origin and parses TRUST_PROXY", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://u:p@h:5432/d", WEB_PUBLIC_URL: "http://localhost:3000/", TRUST_PROXY: "true", API_KEY_PEPPER: "p".repeat(16) });
    expect(env.WEB_PUBLIC_URL).toBe("http://localhost:3000");
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.API_PORT).toBe(4000);
  });
});

describe("WAITLIST_GLOBAL_CAP_PER_HOUR", () => {
  const base = { DATABASE_URL: "postgres://u:p@h:5432/d", WEB_PUBLIC_URL: "http://localhost:3000", API_KEY_PEPPER: "p".repeat(16) };

  it("defaults to 200 (also when empty)", () => {
    expect(loadEnv(base).WAITLIST_GLOBAL_CAP_PER_HOUR).toBe(200);
    expect(loadEnv({ ...base, WAITLIST_GLOBAL_CAP_PER_HOUR: "" }).WAITLIST_GLOBAL_CAP_PER_HOUR).toBe(200);
  });

  it("parses a positive integer", () => {
    expect(loadEnv({ ...base, WAITLIST_GLOBAL_CAP_PER_HOUR: "50" }).WAITLIST_GLOBAL_CAP_PER_HOUR).toBe(50);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects %s", (v) => {
    expect(() => loadEnv({ ...base, WAITLIST_GLOBAL_CAP_PER_HOUR: v })).toThrow(/WAITLIST_GLOBAL_CAP_PER_HOUR/);
  });
});

describe("ingest env", () => {
  const base = { DATABASE_URL: "postgres://u:p@h:5432/d", WEB_PUBLIC_URL: "http://localhost:3000", API_KEY_PEPPER: "p".repeat(32) };

  it("defaults: debug off, no admin token, API_HOST 0.0.0.0", () => {
    const env = loadEnv({ ...base, DEV_ADMIN_TOKEN: "" });
    expect(env.DEV_ADMIN_TOKEN).toBeUndefined();
    expect(env.INGEST_DEBUG).toBe(false);
    expect(env.API_HOST).toBe("0.0.0.0");
  });

  it("parses the ingest vars", () => {
    const env = loadEnv({ ...base, DEV_ADMIN_TOKEN: "t".repeat(64), INGEST_DEBUG: "true", API_HOST: "127.0.0.1" });
    expect(env.DEV_ADMIN_TOKEN).toBe("t".repeat(64));
    expect(env.INGEST_DEBUG).toBe(true);
    expect(env.API_HOST).toBe("127.0.0.1");
    expect(env.API_KEY_PEPPER).toBe("p".repeat(32));
  });

  it("requires API_KEY_PEPPER of at least 16 chars", () => {
    const { API_KEY_PEPPER: _, ...noPepper } = base;
    expect(() => loadEnv(noPepper)).toThrow(/API_KEY_PEPPER/);
    expect(() => loadEnv({ ...base, API_KEY_PEPPER: "short" })).toThrow(/API_KEY_PEPPER/);
  });

  it("rejects a short admin token", () => {
    expect(() => loadEnv({ ...base, DEV_ADMIN_TOKEN: "short" })).toThrow(/DEV_ADMIN_TOKEN/);
  });

  it("allows a change-me pepper outside production", () => {
    expect(loadEnv({ ...base, API_KEY_PEPPER: "change-me-to-something-random" }).API_KEY_PEPPER).toContain("change-me");
  });

  describe("in production", () => {
    const prod = { ...base, NODE_ENV: "production" };

    it("accepts the defaults", () => {
      expect(loadEnv(prod).NODE_ENV).toBe("production");
      expect(loadEnv({ ...prod, DEV_ADMIN_TOKEN: "", INGEST_DEBUG: "false" }).INGEST_DEBUG).toBe(false);
    });

    it.each([
      ["INGEST_DEBUG", "true"],
      ["DEV_ADMIN_TOKEN", "t".repeat(64)],
    ])("rejects %s", (name, value) => {
      expect(() => loadEnv({ ...prod, [name]: value })).toThrow(
        new RegExp(`${name}: dev-only setting; must be unset \\(or false\\) when NODE_ENV=production`),
      );
    });

    it.each(["false", "0"])("refuses COOKIE_SECURE=%s", (v) => {
      expect(() => loadEnv({ ...prod, COOKIE_SECURE: v })).toThrow(/COOKIE_SECURE: must not be false when NODE_ENV=production/);
    });

    it("accepts COOKIE_SECURE empty or true (and false outside production)", () => {
      expect(loadEnv({ ...prod, COOKIE_SECURE: "" }).COOKIE_SECURE).toBe("");
      expect(loadEnv({ ...prod, COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe("true");
      expect(loadEnv({ ...base, COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe("false");
    });

    it("refuses a change-me pepper", () => {
      expect(() => loadEnv({ ...prod, API_KEY_PEPPER: "change-me-to-something-random" })).toThrow(/API_KEY_PEPPER: placeholder/);
    });
  });
});

describe("MIGRATIONS_DIR", () => {
  it("empty counts as unset (default folder); a value wins", async () => {
    const { migrationsFolder } = await import("../src/db/migrate.js");
    const prev = process.env.MIGRATIONS_DIR;
    try {
      process.env.MIGRATIONS_DIR = "";
      expect(migrationsFolder()).toMatch(/[\\/]drizzle$/);
      process.env.MIGRATIONS_DIR = "/srv/migrations";
      expect(migrationsFolder()).toBe("/srv/migrations");
    } finally {
      if (prev === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = prev;
    }
  });
});
