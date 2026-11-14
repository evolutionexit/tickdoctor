import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { HttpError } from "../errors.js";

// GET /downloads/agent/latest.jar (contract app.ts "Agent download"): newest tickdoctor-agent-<semver>.jar in AGENT_JAR_DIR.

const JAR = /^tickdoctor-agent-(\d+)\.(\d+)\.(\d+)\.jar$/;

export interface AgentJar {
  version: string;
  fileName: string;
  path: string;
}

/** Newest agent jar by semver (not by mtime or name order), or null when the dir is unset/empty/missing. */
export async function findLatestAgentJar(dir: string | undefined): Promise<AgentJar | null> {
  if (!dir) return null;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { v: [number, number, number]; name: string } | null = null;
  for (const name of names) {
    const m = JAR.exec(name);
    if (!m) continue;
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) {
      best = { v, name };
    }
  }
  return best ? { version: best.v.join("."), fileName: best.name, path: join(dir, best.name) } : null;
}

export function downloadRoutes(deps: { agentJarDir: string | undefined }) {
  const app = new Hono();
  app.get("/agent/latest.jar", async () => {
    const jar = await findLatestAgentJar(deps.agentJarDir);
    if (!jar) throw new HttpError(404, "not_found", "No agent build available");
    const st = await stat(jar.path).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, "not_found", "No agent build available");
    const body = Readable.toWeb(createReadStream(jar.path)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/java-archive",
        "content-length": String(st.size),
        "content-disposition": `attachment; filename="${jar.fileName}"`,
        "x-agent-version": jar.version,
        "cache-control": "no-cache",
      },
    });
  });
  return app;
}
