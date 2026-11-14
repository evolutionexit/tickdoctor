import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./app-helpers";

// Phase 6 fixtures: rows written straight into Postgres (same shapes as apps/api/test/phase6.test.ts) so the UI specs don't
// depend on the detector timing. Real-time pushes are only used where the detector itself is under test (alerts dispatch).
const dcEnv = { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` };
/** Runs a (possibly large) SQL script through psql stdin. */
export function sqlScript(script: string): string {
  return execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "tickdoctor", "-tA", "-v", "ON_ERROR_STOP=1"], {
    cwd: repo,
    env: dcEnv,
    encoding: "utf8",
    input: script,
  }).trim();
}
export const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const j = (o: unknown) => `$j$${JSON.stringify(o)}$j$::jsonb`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx = (n: string): any => JSON.parse(readFileSync(join(repo, `apps/api/test/fixtures/ingest/${n}.json`), "utf8"));

export interface FindingSpec {
  key: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  ruleId?: string;
  scope?: "incident" | "server";
  status?: "open" | "marked_fixed" | "confirmed_fixed";
  incidentIds?: string[];
}
/** Inserts findings; returns their ids by key. */
export function insertFindings(serverId: string, specs: FindingSpec[]): Record<string, string> {
  const ids: Record<string, string> = {};
  const lines: string[] = [];
  const now = Date.now();
  for (const s of specs) {
    const id = randomUUID();
    ids[s.key] = id;
    const st = s.status ?? "open";
    lines.push(
      `insert into findings (id,server_id,rule_id,scope,dedup_key,severity,title,explanation,evidence,suggested_fix,status,first_seen_at,last_seen_at,marked_fixed_at,confirmed_fixed_at,resolved_by) values (${q(id)},${q(serverId)},${q(s.ruleId ?? "entity-explosion")},${q(s.scope ?? "incident")},${q(s.key)},${q(s.severity)},${q(s.title)},${q(`Explanation for ${s.title}.`)},${j({ numbers: [] })},${q(`Fix for ${s.title}.`)},${q(st)},${q(iso(now - 3 * 3_600_000))},${q(iso(now - 20 * MIN))},${st === "marked_fixed" ? q(iso(now - 5 * MIN)) : "null"},${st === "confirmed_fixed" ? q(iso(now - 5 * MIN)) : "null"},${st === "confirmed_fixed" ? "'owner'" : "null"});`,
    );
    for (const inc of s.incidentIds ?? []) lines.push(`insert into finding_incidents (finding_id,incident_id) values (${q(id)},${q(inc)});`);
  }
  sqlScript(lines.join("\n"));
  return ids;
}

export interface IncidentWorld {
  closedId: string;
  openId: string | null;
  start: number;
  end: number;
}

/**
 * A complete closed incident (40 -> 30 min ago, critical) with baseline, raw samples (-70..-20 min, +now), a snapshot with worst
 * chunks in "world" and in the custom world "survival_creative", a plugin update + added plugin + view distance change, a crash and an
 * unclean start before it. Optionally an open incident that began 3 minutes ago.
 */
export function seedIncidentWorld(serverId: string, o: { open?: boolean } = {}): IncidentWorld {
  const now = Date.now();
  const start = now - 40 * MIN;
  const end = now - 30 * MIN;
  const closedId = randomUUID();
  const openId = o.open ? randomUUID() : null;
  const MB = 1_048_576;
  const baseline = {
    from: iso(start - 5 * 3_600_000),
    to: iso(start - 15 * MIN),
    healthyMinutes: 240,
    metrics: { mspt_p95: { median: 20, p90: 25 }, tps_1m: { median: 20, p90: 20 }, heap_used_bytes: { median: 1024 * MB, p90: 1100 * MB } },
    entitiesByType: { "minecraft:item": 100 },
    tileEntitiesByType: { "minecraft:hopper": 300 },
    worlds: [{ name: "world", loadedChunks: 400, entities: 800, tileEntities: 300 }],
    plugins: [{ name: "Essentials", version: "2.20" }],
    config: { viewDistance: 8, simulationDistance: 6 },
    jvm: { heapMaxBytes: 4096 * MB, heapInitBytes: 4096 * MB },
  };
  const snap = fx("snapshot").payload;
  snap.worldsDetail = [
    {
      name: "world",
      entitiesByType: { "minecraft:item": 2600, "minecraft:cow": 20 },
      tileEntitiesByType: { "minecraft:hopper": 320 },
      topChunks: [
        { x: 3, z: -7, entities: 1500, tileEntities: 10, byType: { "minecraft:item": 1450, "minecraft:cow": 20 } },
        { x: 0, z: 0, entities: 10, tileEntities: 300, byType: { "minecraft:hopper": 300 } },
      ],
    },
    { name: "survival_creative", entitiesByType: {}, tileEntitiesByType: {}, topChunks: [{ x: 1, z: 2, entities: 2000, tileEntities: 0, byType: { "minecraft:armor_stand": 2000 } }] },
  ];
  snap.sample.world = [{ name: "world", loadedChunks: 1300, entities: 2620, entitiesByType: {}, tileEntitiesByType: {}, countsAgeSeconds: 1 }];
  snap.sample.players = { count: 6, pingAvg: 40 };
  const hello = fx("hello").payload;
  const info1 = { ...hello, plugins: [{ name: "Essentials", version: "2.20", enabled: true }], config: { ...hello.config, viewDistance: 8 } };
  const info2 = { ...hello, plugins: [{ name: "Essentials", version: "2.21", enabled: true }, { name: "Lagger", version: "1.0", enabled: true }], config: { ...hello.config, viewDistance: 12 } };

  const inInc = `ts between ${q(iso(start))}::timestamptz and ${q(iso(end))}::timestamptz`;
  const L: string[] = [];
  L.push(
    `insert into incidents (id,server_id,started_at,ended_at,end_reason,severity,peak_mspt_p95,min_tps_1m,trigger,initial_severity,source,baseline) values (${q(closedId)},${q(serverId)},${q(iso(start))},${q(iso(end))},'recovered','critical',300,8,'mspt','high','raw',${j(baseline)});`,
  );
  L.push(
    `insert into metric_samples (server_id,ts,mspt_avg,mspt_p95,tps_1m,players,heap_used_bytes,detail) select ${q(serverId)}, ts, case when ${inInc} then 80 else 15 end, case when ${inInc} then 120 + (extract(epoch from ts)::bigint % 60) else 22 end, case when ${inInc} then 8 + (extract(epoch from ts)::bigint % 8) else 20 end, 5, ${2048 * MB}, '{}'::jsonb from generate_series(${q(iso(Math.floor((now - 70 * MIN) / 30_000) * 30_000))}::timestamptz, ${q(iso(Math.floor((now - 20 * MIN) / 30_000) * 30_000))}::timestamptz, interval '30 seconds') ts;`,
  );
  L.push(
    `insert into incident_snapshots (server_id,incident_id,trigger,captured_at,mspt_p95_at_trigger,snapshot) values (${q(serverId)},${q(closedId)},'threshold',${q(iso(start + 20_000))},160,${j(snap)});`,
  );
  L.push(`update server_info_history set valid_to=${q(iso(start - 10 * MIN))} where server_id=${q(serverId)} and valid_to is null;`);
  L.push(
    `insert into server_info_history (server_id,valid_from,valid_to,info,info_hash) values (${q(serverId)},${q(iso(start - 3 * 3_600_000))},${q(iso(start - 10 * MIN))},${j(info1)},${q("a" + closedId)}), (${q(serverId)},${q(iso(start - 10 * MIN))},null,${j(info2)},${q("b" + closedId)});`,
  );
  L.push(
    `insert into events (server_id,ts,type,data,event_hash) values (${q(serverId)},${q(iso(start - 12 * MIN))},'crash','{}'::jsonb,${q("c1" + closedId)}), (${q(serverId)},${q(iso(start - 11 * MIN))},'server_start',${j({ uncleanPreviousShutdown: true })},${q("c2" + closedId)});`,
  );
  if (openId) {
    L.push(
      `insert into incidents (id,server_id,started_at,severity,peak_mspt_p95,min_tps_1m,trigger,initial_severity,source) values (${q(openId)},${q(serverId)},${q(iso(now - 3 * MIN))},'high',90,15,'mspt','high','raw');`,
    );
  }
  // the server looks alive for the dashboard
  L.push(
    `update servers set first_hello_at=${q(iso(now - 5 * 3_600_000))}, first_sample_at=${q(iso(now - 5 * 3_600_000))}, last_sample_at=now(), last_seen_at=now() where id=${q(serverId)};`,
  );
  L.push(
    `insert into metric_samples (server_id,ts,mspt_avg,mspt_p95,tps_1m,players,detail) values (${q(serverId)},now(),${openId ? 70 : 15},${openId ? 90 : 22},${openId ? 15 : 20},5,'{}'::jsonb) on conflict do nothing;`,
  );
  sqlScript(L.join("\n"));
  return { closedId, openId, start, end };
}
