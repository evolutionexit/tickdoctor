import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import {
  DEMO_DATASET_PATH,
  type Finding,
  type MetricName,
  type ServerDetail,
  type demoDatasetMeta,
} from "@tickdoctor/shared";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { rows } from "../db/query.js";
import { listFindings } from "../findings/lifecycle.js";
import { byImpact } from "../findings/tips.js";
import { loadIncidentDetail, type FullIncidentDetail } from "../incidents/detail.js";
import { queryPoints } from "../routes/metrics.js";
import { loadDetail } from "../routes/servers.js";
import { slugify } from "../servers.js";

// `cli demo:export <serverId> --name "<made-up name>"` (contract app-phase7.ts "Demo dataset"): reads one server with
// the same functions the app API uses, then CLEANS the result so it can be committed and shown publicly.
//
// File layout (schemaVersion 1):
//   meta       demoDatasetMeta
//   timeKeys   names of every object key whose value is a relative time (seconds BEFORE the anchor = the latest
//              sample; null stays null). Metric points carry the same relative time in position 0.
//   server     ServerDetail (as GET /api/servers/:id at the anchor), ids faked, no key prefix
//   series     { recentSeconds, recentBucketSeconds, olderBucketSeconds, metrics: { <MetricName>: [t, avg, min, max][] } }
//              (7 days: 1-min buckets for the last day, 5-min buckets before; gaps omitted like the API)
//   incidents  IncidentDetail[] (as GET /api/incidents/:id), newest first
//   findings   Finding[] incl. tuning tips (split with isTuningTip), impact order

export const DEMO_SCHEMA_VERSION = 1;
export const DEMO_METRICS: MetricName[] = [
  "tps_1m",
  "mspt_avg",
  "mspt_p95",
  "players",
  "entities",
  "loaded_chunks",
  "heap_used_bytes",
  "host_cpu",
  "cpu_temp_c",
  "mem_available_bytes",
  "swap_used_bytes",
  "disk_used_bytes",
];
/** Plugin names that may appear (public, ours). Compared case-insensitively. */
export const ALLOWED_PLUGINS = ["spark", "TickDoctor"];
export const DEFAULT_WORLDS = ["world", "world_nether", "world_the_end"];
export const FAKE_UUID_RE = /^de300000-0000-4000-8000-\d{12}$/;
export const ANCHOR_NOTE = "all times are seconds before the latest sample";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export type MetricPointRel = [number, number | null, number | null, number | null];
export interface DemoDataset {
  meta: z.infer<typeof demoDatasetMeta>;
  timeKeys: string[];
  server: unknown;
  series: {
    recentSeconds: number;
    recentBucketSeconds: number;
    olderBucketSeconds: number;
    metrics: Partial<Record<MetricName, MetricPointRel[]>>;
  };
  incidents: unknown[];
  findings: unknown[];
}

export interface RawExport {
  anchorMs: number;
  serverName: string;
  server: ServerDetail;
  series: Partial<Record<MetricName, [string, number | null, number | null, number | null][]>>;
  incidents: FullIncidentDetail[];
  findings: Finding[];
  /** Every plugin name the server ever reported. */
  pluginNames: string[];
  /** Every world name the server ever reported. */
  worldNames: string[];
}

/** Reads everything with the app's own functions. Throws when the server doesn't exist or has no data. */
export async function readServerForDemo(db: Db, serverId: string): Promise<RawExport> {
  const [s] = await rows<{ owner_id: string; name: string; last_sample_at: Date | null; last_seen_at: Date | null; last_bucket: Date | null }>(
    db,
    sql`select s.owner_id, s.name, s.last_sample_at, s.last_seen_at,
               (select max(bucket) from metric_rollups_1m r where r.server_id = s.id) as last_bucket
          from servers s where s.id = ${serverId}`,
  );
  if (!s) throw new Error("server not found");
  // The anchor is the latest moment the server was heard from, so no exported time lies after it.
  const candidates = [s.last_sample_at, s.last_seen_at, s.last_bucket].filter((v): v is Date => v !== null).map((v) => new Date(v).getTime());
  if (candidates.length === 0) throw new Error("server has no data to export");
  const lastBucketEnd = s.last_bucket ? new Date(s.last_bucket).getTime() + MIN : 0;
  const anchorMs = Math.max(...candidates, lastBucketEnd - MIN);

  const server = await loadDetail(db, serverId, anchorMs);
  if (!server.latest) {
    // Raw samples are long gone (raw retention is 1–7 days): take the latest 1-min rollup instead.
    const [l] = await rows<{ bucket: Date; tps: number | null; avg: number | null; p95: number | null; players: number | null }>(
      db,
      sql`select bucket, tps_1m_min as tps, mspt_avg_avg as avg, mspt_p95_avg as p95, players_max as players
            from metric_rollups_1m where server_id = ${serverId} order by bucket desc limit 1`,
    );
    if (l) {
      const n = (v: number | null) => (v === null ? null : Number(v));
      server.latest = { ts: new Date(l.bucket).toISOString(), tps1m: n(l.tps), msptAvg: n(l.avg), msptP95: n(l.p95), players: n(l.players) };
    }
  }
  const series: RawExport["series"] = {};
  const from = new Date(anchorMs - 7 * DAY);
  const mid = new Date(anchorMs - DAY);
  const to = new Date(anchorMs + MIN);
  for (const m of DEMO_METRICS) {
    const older = await queryPoints(db, serverId, m, "1m", 300, from, mid);
    const recent = await queryPoints(db, serverId, m, "1m", 60, mid, to);
    const pts = [...older, ...recent];
    if (pts.some((p) => p[1] !== null)) series[m] = pts;
  }
  const incIds = await rows<{ id: string }>(db, sql`select id from incidents where server_id = ${serverId} order by started_at desc`);
  const incidents: FullIncidentDetail[] = [];
  for (const { id } of incIds) {
    const d = await loadIncidentDetail(db, id, s.owner_id, anchorMs);
    if (d) incidents.push(d);
  }
  const findings = (await listFindings(db, serverId)).sort(byImpact);

  const plugins = await rows<{ name: string }>(
    db,
    sql`select distinct plugin as name from plugin_inventory_history where server_id = ${serverId}
        union select distinct p->>'name' from server_info_history h, jsonb_array_elements(coalesce(h.info->'plugins', '[]'::jsonb)) p
         where h.server_id = ${serverId}`,
  );
  const worlds = await rows<{ name: string }>(
    db,
    sql`select distinct w->>'name' as name from server_info_history h, jsonb_array_elements(coalesce(h.info->'worlds', '[]'::jsonb)) w
         where h.server_id = ${serverId}`,
  );
  return {
    anchorMs,
    serverName: s.name,
    server,
    series,
    incidents,
    findings,
    pluginNames: plugins.map((p) => p.name).filter(Boolean),
    worldNames: worlds.map((w) => w.name).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /(?<![0-9a-z:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-z:])/gi;
/** Clock times like 17:08:50 also look like hex groups: only treat it as IPv6 with "::", a hex letter or ≥ 4 groups. */
const ipv6 = (m: string) => (m.includes("::") || /[a-f]/i.test(m) || m.split(":").length >= 4 ? "<ip>" : m);
const HEX_RE = /\b(?:[0-9a-f]{64}|[0-9a-f]{32})\b/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Plugin A", "Plugin B", … "Plugin Z", "Plugin AA", … */
export function pluginAlias(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Plugin ${s}`;
}

export interface CleanContext {
  anchorMs: number;
  realNames: string[];
  madeUpName: string;
  pluginNames: string[];
  worldNames: string[];
}

export class Cleaner {
  private readonly ids = new Map<string, string>();
  private readonly plugins = new Map<string, string>(); // lower-case real name → alias
  private readonly worlds = new Map<string, string>(); // real name → alias
  readonly timeKeys = new Set<string>();
  private textRules: [RegExp, string | ((m: string) => string)][] = [];

  constructor(private readonly ctx: CleanContext) {
    const allowed = new Set(ALLOWED_PLUGINS.map((p) => p.toLowerCase()));
    const sorted = [...new Set(ctx.pluginNames)].filter((p) => !allowed.has(p.toLowerCase())).sort((a, b) => a.localeCompare(b));
    for (const p of sorted) if (!this.plugins.has(p.toLowerCase())) this.plugins.set(p.toLowerCase(), pluginAlias(this.plugins.size));
    for (const w of [...new Set(ctx.worldNames)].sort()) this.world(w);
    this.buildRules();
  }

  private world(name: string): void {
    if (DEFAULT_WORLDS.includes(name) || this.worlds.has(name)) return;
    this.worlds.set(name, `world_${this.worlds.size + 2}`);
  }

  private buildRules() {
    const rules: [RegExp, string | ((m: string) => string)][] = [];
    // The real server name (texts don't normally contain it; belt and braces). Very short names are skipped: they
    // would match ordinary words.
    for (const n of [...this.ctx.realNames].filter((x) => x && x.trim().length >= 4).sort((a, b) => b.length - a.length)) {
      rules.push([new RegExp(`(?<![A-Za-z0-9])${escapeRe(n.trim())}(?![A-Za-z0-9])`, "gi"), this.ctx.madeUpName]);
    }
    // Longest names first so "ViaBackwards" isn't half-replaced by a shorter name. Word-ish boundaries also catch
    // package names in stack frames (com.viaversion.…).
    const names = [...this.plugins.keys()].sort((a, b) => b.length - a.length);
    if (names.length) {
      rules.push([
        new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRe).join("|")})(?![A-Za-z0-9])`, "gi"),
        (m) => this.plugins.get(m.toLowerCase()) ?? "Plugin",
      ]);
    }
    const worlds = [...this.worlds.keys()].sort((a, b) => b.length - a.length);
    if (worlds.length) {
      rules.push([new RegExp(`(?<![A-Za-z0-9_])(?:${worlds.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g"), (m) => this.worlds.get(m) ?? "world"]);
    }
    rules.push([IPV4_RE, "<ip>"], [IPV6_RE, ipv6], [HEX_RE, "<hex>"]);
    rules.push([/\bPlugin (Plugin [A-Z]+)\b/g, "$1"]);
    this.textRules = rules;
  }

  fakeId(real: string): string {
    const k = real.toLowerCase();
    let f = this.ids.get(k);
    if (!f) {
      f = `de300000-0000-4000-8000-${String(this.ids.size + 1).padStart(12, "0")}`;
      this.ids.set(k, f);
    }
    return f;
  }

  rel(ms: number): number {
    return Math.round((this.ctx.anchorMs - ms) / 1000);
  }

  text(s: string): string {
    let out = s.replace(UUID_RE, (m) => (FAKE_UUID_RE.test(m) ? m : this.fakeId(m)));
    for (const [re, rep] of this.textRules) out = typeof rep === "string" ? out.replace(re, rep) : out.replace(re, rep);
    return out;
  }

  /** Deep clean: times → relative seconds (key recorded), world fields mapped, every string scrubbed. */
  value(v: unknown, key?: string): unknown {
    if (typeof v === "string") {
      if (ISO_RE.test(v)) {
        if (key) this.timeKeys.add(key);
        return this.rel(Date.parse(v));
      }
      return this.text(v);
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.value(x, k);
      return out;
    }
    return v;
  }
}

/** plugin-exceptions evidence: code locations and plugin-specific error classes say too much; keep the gist. */
function scrubFinding(f: Finding): Finding {
  if (f.ruleId !== "plugin-exceptions") return f;
  const numbers = f.evidence.numbers
    .filter((n) => n.label !== "Where in the code")
    .map((n) => {
      if (n.label !== "Most common error" || typeof n.value !== "string") return n;
      return /^(java|javax|jdk)\./.test(n.value) ? n : { ...n, value: n.value.split(".").pop()?.replace(/[^A-Za-z]/g, "") || "Exception" };
    });
  return { ...f, evidence: { ...f.evidence, numbers } };
}

/** Host info without machine specifics: OS family, "ARM64, 4 cores", memory rounded to whole GB. */
export function genericHost(h: NonNullable<ServerDetail["info"]>["host"]): NonNullable<ServerDetail["info"]>["host"] {
  const os = /windows/i.test(h.os) ? "Windows" : /mac|darwin/i.test(h.os) ? "macOS" : /linux/i.test(h.os) ? "Linux" : "Other";
  const arch = /aarch64|arm64/i.test(h.arch) ? "ARM64" : /x86_64|amd64|x64/i.test(h.arch) ? "x86-64" : /arm/i.test(h.arch) ? "ARM" : "CPU";
  const GB = 1024 ** 3;
  return {
    os,
    arch: h.arch,
    cpuModel: `${arch}, ${h.cores} ${h.cores === 1 ? "core" : "cores"}`,
    cores: h.cores,
    memTotalBytes: Math.round(h.memTotalBytes / GB) * GB,
  };
}

const round4 = (v: number | null) => (v === null ? null : Number(v.toPrecision(4)));

/** World names that appear anywhere in the incidents/findings (snapshots can name worlds the hello never listed). */
export function worldNamesIn(raw: Pick<RawExport, "incidents" | "findings">): string[] {
  const out = new Set<string>();
  const fromFinding = (f: Finding) => f.evidence.chunks?.forEach((ch) => out.add(ch.world));
  for (const d of raw.incidents) {
    d.snapshot?.worlds.forEach((w) => out.add(w.name));
    d.snapshot?.worstChunks.forEach((ch) => out.add(ch.world));
    // World items are keyed "<world>:entities" / "<world>:loaded_chunks".
    d.whatChanged.items
      .filter((i) => i.kind === "world" && i.key.includes(":"))
      .forEach((i) => out.add(i.key.slice(0, i.key.lastIndexOf(":"))));
    d.findings.forEach(fromFinding);
  }
  raw.findings.forEach(fromFinding);
  return [...out];
}

export function cleanExport(raw: RawExport, opts: { name: string; source: "pi-test-history" | "seed" }): DemoDataset {
  const c = new Cleaner({
    anchorMs: raw.anchorMs,
    realNames: [raw.serverName, raw.server.name, raw.server.slug],
    madeUpName: opts.name,
    pluginNames: raw.pluginNames,
    worldNames: [...raw.worldNames, ...worldNamesIn(raw)],
  });
  // The server id gets the first fake id.
  c.fakeId(raw.server.id);
  const server = c.value({
    ...raw.server,
    info: raw.server.info ? { ...raw.server.info, host: genericHost(raw.server.info.host) } : null,
    name: opts.name,
    slug: slugify(opts.name),
    keyPrefix: null,
    keyCreatedAt: null,
  });
  const metrics: DemoDataset["series"]["metrics"] = {};
  for (const [m, pts] of Object.entries(raw.series) as [MetricName, NonNullable<RawExport["series"][MetricName]>][]) {
    metrics[m] = pts.map(([t, a, mn, mx]) => [c.rel(Date.parse(t)), round4(a), round4(mn), round4(mx)]);
  }
  const incidents = raw.incidents.map((d) => c.value({ ...d, findings: d.findings.map(scrubFinding) }));
  const findings = raw.findings.map((f) => c.value(scrubFinding(f)));
  return {
    meta: { schemaVersion: DEMO_SCHEMA_VERSION, serverName: opts.name, exportedFrom: opts.source, anchorNote: ANCHOR_NOTE },
    timeKeys: [...c.timeKeys].sort(),
    server,
    series: { recentSeconds: DAY / 1000, recentBucketSeconds: 60, olderBucketSeconds: 300, metrics },
    incidents,
    findings,
  };
}

/** The seed's demo servers have ids 5eed0000-…; everything else is treated as the Pi history export. */
export const sourceFor = (serverId: string): "pi-test-history" | "seed" => (/^5eed0000-/i.test(serverId) ? "seed" : "pi-test-history");

export async function exportDemo(db: Db, serverId: string, opts: { name: string; source?: "pi-test-history" | "seed" }): Promise<DemoDataset> {
  const raw = await readServerForDemo(db, serverId);
  return cleanExport(raw, { name: opts.name, source: opts.source ?? sourceFor(serverId) });
}

/** Size budget for the committed file (the web bundles it). */
export const MAX_DATASET_BYTES = 1_500_000;

/** Repo root = nearest parent with pnpm-workspace.yaml (else the current directory). */
export function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function serializeDataset(data: DemoDataset): string {
  return `${JSON.stringify(data, null, 1)}\n`;
}

/** Writes the dataset (default <repo>/apps/web/content/demo/dataset.json). Refuses files over MAX_DATASET_BYTES. */
export async function writeDemoDataset(data: DemoDataset, out?: string): Promise<{ path: string; bytes: number }> {
  const path = resolve(out ?? join(repoRoot(), DEMO_DATASET_PATH));
  const text = serializeDataset(data);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_DATASET_BYTES) throw new Error(`dataset is ${bytes} bytes, over the ${MAX_DATASET_BYTES} budget`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return { path, bytes };
}
