import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { events } from "../src/db/schema.js";
import { testDatabaseUrl } from "./db-url.js";
import { handle, makeServer, resetStorage } from "./helpers.js";

afterAll(() => handle.close());
beforeEach(resetStorage);

const apiDir = fileURLToPath(new URL("..", import.meta.url));

/** Runs the real CLI in a child process with stdout piped; reads it slowly so the pipe stays full. */
function runCli(args: string[]): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 2);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: Buffer.concat(chunks) }));
  });
}

describe("cli stdout", () => {
  it("does not truncate large output written into a pipe (rules:context > 1 MB)", async () => {
    const s = await makeServer();
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    // 5,000 exceptions in the last ~21 h (the context keeps the newest 5,000 within window + 24 h).
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      serverId: s.serverId,
      ts: new Date(now - 60_000 - i * 15_000),
      type: "exception",
      data: { exceptionClass: "java.lang.IllegalStateException", message: "x".repeat(300), stackHash: `h${i}`, count: 1 },
      eventHash: `e${i}`,
    }));
    for (let i = 0; i < rows.length; i += 1000) await handle.db.insert(events).values(rows.slice(i, i + 1000));
    const r = await runCli(["rules:context", s.serverId, "--scope", "server", "--at", new Date(now).toISOString()]);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(1_048_576);
    const ctx = JSON.parse(r.out.toString("utf8"));
    expect(ctx.events).toHaveLength(5_000);
  }, 60_000);
});
