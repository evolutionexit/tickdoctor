import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/error-handler.js";

afterEach(() => vi.restoreAllMocks());

describe("errorHandler: unhandled errors", () => {
  it("logs only method, path (no query), err.name and err.code; never the message, stack or object", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/api/thing/:id", () => {
      const err = new Error('duplicate key value violates "users_email" Key (email)=(victim@example.com)') as Error & {
        code: string;
        query: string;
      };
      err.name = "PostgresError";
      err.code = "23505";
      err.query = "insert into users (email) values ('victim@example.com')";
      throw err;
    });

    const res = await app.request("/api/thing/42?token=abc123secret");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toHaveLength(1);
    const line = logged[0]![0];
    expect(typeof line).toBe("string");
    expect(line).toBe("unhandled error GET /api/thing/42 name=PostgresError code=23505");
    for (const leak of ["victim@example.com", "token", "abc123secret", "insert into", "at "]) {
      expect(line as string).not.toContain(leak);
    }
  });

  it("copes with non-Error throws and odd names/codes", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/x", () => {
      const err = new Error("boom") as Error & { code: unknown };
      err.name = "Weird\nName with spaces";
      err.code = { nested: "victim@example.com" };
      throw err;
    });
    expect((await app.request("/x")).status).toBe(500);
    expect(logged[0]![0]).toBe("unhandled error GET /x name=Weird_Name_with_spaces code=-");
  });
});
