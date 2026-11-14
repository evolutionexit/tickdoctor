import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEMO_DATASET_PATH } from "@tickdoctor/shared";
import { main } from "../src/cli.js";
import { Cleaner, cleanExport, exportDemo, pluginAlias, repoRoot, serializeDataset } from "../src/demo/export.js";
import { findingIncidents, findings, incidents, metricRollups1m, pluginInventoryHistory, serverInfoHistory, servers } from "../src/db/schema.js";
import { testDatabaseUrl } from "./db-url.js";
import { datasetProblems } from "./demo-check.js";
import { fixture, handle, makeServer, resetStorage } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("Cleaner (pure)", () => {
  const anchorMs = Date.parse("2026-11-10T06:00:00Z");
  const make = () =>
    new Cleaner({
      anchorMs,
      realNames: ["Pi (test history)"],
      madeUpName: "Creeper Hollow SMP",
      pluginNames: ["ViaVersion", "ViaBackwards", "spark", "TickDoctor", "Essentials", "Via"],
      worldNames: ["world", "world_nether", "creative", "skyblock_v2"],
    });

  it("plugin aliases A…Z, AA…", () => {
    expect([0, 1, 25, 26, 27].map(pluginAlias)).toEqual(["Plugin A", "Plugin B", "Plugin Z", "Plugin AA", "Plugin AB"]);
  });

  it("renames plugins consistently everywhere (longest first, case-insensitive, package names), keeps spark/TickDoctor", () => {
    const c = make();
    // Sorted: Essentials → A, Via → B, ViaBackwards → C, ViaVersion → D.
    expect(c.text("Plugin ViaVersion 5.12 installed.")).toBe("Plugin D 5.12 installed.");
    expect(c.text("ViaBackwards and Via and viaversion")).toBe("Plugin C and Plugin B and Plugin D");
    expect(c.text("at com.viaversion.Foo.bar(Foo.java:3) and net.essentials.X")).toBe("at com.Plugin D.Foo.bar(Foo.java:3) and net.Plugin A.X");
    expect(c.text("spark and TickDoctor stay")).toBe("spark and TickDoctor stay");
    expect(c.text("Plugin Essentials threw 40 errors")).toBe("Plugin A threw 40 errors");
    expect(c.text("Plugin Essentials threw 40 errors")).toBe(make().text("Plugin Essentials threw 40 errors"));
  });

  it("maps non-default worlds to world_2, world_3 …; defaults stay", () => {
    const c = make();
    expect(c.text("creative: entities, skyblock_v2 and world_nether, world")).toBe("world_2: entities, world_3 and world_nether, world");
    expect(c.value({ world: "creative", x: 1, z: 2 })).toEqual({ world: "world_2", x: 1, z: 2 });
    // A word that merely contains a world name is left alone.
    expect(c.text("creatively")).toBe("creatively");
  });

  it("times → seconds before the anchor (keys recorded); ids → stable fake UUIDs; IPs and hashes scrubbed; real name replaced", () => {
    const c = make();
    const out = c.value({
      startedAt: "2026-11-10T05:00:00.000Z",
      endedAt: null,
      nested: [{ ts: "2026-11-10T05:59:30Z" }],
      id: "3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b",
      again: "see 3F2B1C9E-8A7D-4E6F-9B0A-1C2D3E4F5A6B",
      msg: "from 192.168.50.7 and fe80::1:2:3:4 id 3b9a0c1f5e8d7a6b4c2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c",
      title: "Pi (test history) is lagging",
    }) as Record<string, unknown>;
    expect(out.startedAt).toBe(3600);
    expect(out.endedAt).toBeNull();
    expect((out.nested as { ts: number }[])[0]!.ts).toBe(30);
    expect(out.id).toBe("de300000-0000-4000-8000-000000000001");
    expect(out.again).toBe("see de300000-0000-4000-8000-000000000001");
    expect(out.msg).toBe("from <ip> and <ip> id <hex>");
    expect(out.title).toBe("Creeper Hollow SMP is lagging");
    expect([...c.timeKeys].sort()).toEqual(["startedAt", "ts"]);
  });
});

describe("demo:export against the database", () => {
  const saved = process.env.DATABASE_URL;
  let dir = "";
  beforeAll(async () => {
    await resetStorage();
    process.env.DATABASE_URL = testDatabaseUrl();
    dir = await mkdtemp(join(tmpdir(), "td-demo-"));
  });
  afterAll(async () => {
    process.env.DATABASE_URL = saved;
    await rm(dir, { recursive: true, force: true });
    await handle.close();
  });

  async function seedHistory() {
    const s = await makeServer({ name: "Overleven", plan: "pro" });
    const now = Date.now();
    const first = now - 3 * HOUR;
    await handle.db.update(servers).set({ firstSampleAt: new Date(first), lastSampleAt: new Date(now - 5_000), lastSeenAt: new Date(now - 5_000) }).where(eq(servers.id, s.serverId));
    const hello = fixture("hello");
    const info = {
      ...hello.payload,
      agentVersion: "0.1.2",
      plugins: [
        { name: "spark", version: "1.10", enabled: true },
        { name: "TickDoctor", version: "0.1.2", enabled: true },
        { name: "EssentialsX", version: "2.21", enabled: true },
        { name: "ViaVersion", version: "5.12.2", enabled: true },
      ],
      worlds: [...hello.payload.worlds, { name: "creative_build", environment: "NORMAL" }],
    };
    await handle.db.insert(serverInfoHistory).values({ serverId: s.serverId, validFrom: new Date(first), info, infoHash: "x" });
    await handle.db.insert(pluginInventoryHistory).values(info.plugins.map((p: { name: string; version: string }) => ({ serverId: s.serverId, plugin: p.name, version: p.version, firstSeen: new Date(first) })));
    await handle.db.insert(metricRollups1m).values(
      Array.from({ length: 170 }, (_, i) => ({ serverId: s.serverId, bucket: new Date(Math.floor(now / MIN) * MIN - (i + 1) * MIN), sampleCount: 6, tps_1m_avg: 19.95, tps_1m_min: 19.9, tps_1m_max: 20, mspt_p95_avg: 12.3456, players_max: 3 })),
    );
    const [inc] = await handle.db
      .insert(incidents)
      .values({ serverId: s.serverId, startedAt: new Date(now - 2 * HOUR), endedAt: new Date(now - 2 * HOUR + 10 * MIN), endReason: "recovered", severity: "high", peakMsptP95: 140, trigger: "mspt", source: "rollup_1m" })
      .returning({ id: incidents.id });
    const t = new Date(now - 2 * HOUR);
    const base = { serverId: s.serverId, scope: "incident", status: "open", firstSeenAt: t, lastSeenAt: t, suggestedFix: "Update EssentialsX or remove it." };
    const fs = await handle.db
      .insert(findings)
      .values([
        {
          ...base, ruleId: "plugin-exceptions", dedupKey: "plugin:EssentialsX", severity: "high",
          title: "EssentialsX keeps throwing errors",
          explanation: "EssentialsX threw 120 errors in creative_build (from 10.0.0.7, player 3b9a0c1f5e8d7a6b4c2e1f0a9b8c7d6e).",
          evidence: { numbers: [{ label: "Most common error", value: "net.essentialsx.UserDataException" }, { label: "Where in the code", value: "com.earth2me.essentials.User.save(User.java:42)" }, { label: "Plugin version", value: "2.21" }], chunks: [{ world: "creative_build", x: 1, z: 2 }], chart: { metric: "mspt_p95", from: t.toISOString(), to: new Date(now - HOUR).toISOString() } },
        },
        { ...base, ruleId: "jvm-flags", scope: "server", dedupKey: "xms-ne-xmx", severity: "info", title: "Tuning tip: Xms", explanation: "tip", evidence: { numbers: [] }, suggestedFix: "f" },
      ])
      .returning({ id: findings.id });
    await handle.db.insert(findingIncidents).values({ findingId: fs[0]!.id, incidentId: inc!.id });
    return { serverId: s.serverId, incidentId: inc!.id, findingIds: fs.map((f) => f.id), now };
  }

  it("exports a clean dataset with the app's own shapes (real detail function), passing every check", async () => {
    const { serverId, incidentId, findingIds } = await seedHistory();
    const data = await exportDemo(handle.db, serverId, { name: "Creeper Hollow SMP" });
    const text = serializeDataset(data);
    expect(datasetProblems(text, ["creative_build", "earth2me", serverId, incidentId, ...findingIds, "10.0.0.7"])).toEqual([]);
    expect(data.meta).toEqual({ schemaVersion: 1, serverName: "Creeper Hollow SMP", exportedFrom: "pi-test-history", anchorNote: "all times are seconds before the latest sample" });
    const server = data.server as { name: string; slug: string; keyPrefix: unknown; id: string; latest: { players: number } | null };
    expect(server).toMatchObject({ name: "Creeper Hollow SMP", slug: "creeper-hollow-smp", keyPrefix: null, id: "de300000-0000-4000-8000-000000000001" });
    expect(server.latest?.players).toBe(3);
    // Series: relative times ascending in age order, values rounded.
    const p95 = data.series.metrics.mspt_p95!;
    expect(p95.length).toBe(170);
    expect(p95[0]![1]).toBe(12.35);
    expect(p95.every((p) => p[0] >= 0)).toBe(true);
    // Incidents and findings, cleaned consistently.
    expect(data.incidents).toHaveLength(1);
    const f = (data.findings as { ruleId: string; title: string; explanation: string; dedupKey: string; incidentIds: string[]; evidence: { numbers: { label: string; value: unknown }[]; chunks?: { world: string }[] } }[]).find((x) => x.ruleId === "plugin-exceptions")!;
    // spark, TickDoctor kept; EssentialsX → Plugin A, ViaVersion → Plugin B.
    expect(f.title).toBe("Plugin A keeps throwing errors");
    expect(f.dedupKey).toBe("plugin:Plugin A");
    expect(f.explanation).toBe("Plugin A threw 120 errors in world_2 (from <ip>, player <hex>).");
    expect(f.evidence.chunks).toEqual([{ world: "world_2", x: 1, z: 2 }]);
    expect(f.evidence.numbers.map((n) => n.label)).toEqual(["Most common error", "Plugin version"]);
    expect(f.evidence.numbers[0]!.value).toBe("UserDataException");
    const inc = data.incidents[0] as { incident: { id: string }; findings: { title: string }[] };
    expect(inc.findings.map((x) => x.title)).toEqual(["Plugin A keeps throwing errors"]);
    expect(f.incidentIds).toEqual([inc.incident.id]);
    // Tips are included (the web splits them).
    expect((data.findings as { severity: string }[]).some((x) => x.severity === "info")).toBe(true);
  });

  it("CLI demo:export writes the file (--out) and reports its size; bad args → usage", async () => {
    const { serverId } = await seedHistory();
    const out = join(dir, "dataset.json");
    const lines: string[] = [];
    expect(await main(["demo:export", serverId, "--name", "Creeper Hollow SMP", "--out", out], (l) => lines.push(l))).toBe(0);
    expect(lines.some((l) => /^bytes=\d+$/.test(l))).toBe(true);
    expect(datasetProblems(await readFile(out, "utf8"), ["Overleven"])).toEqual([]);
    await expect(main(["demo:export", serverId], () => {})).rejects.toThrow(/usage/);
    await expect(main(["demo:export", "nope", "--name", "x"], () => {})).rejects.toThrow(/usage/);
    await expect(main(["demo:export", "00000000-0000-4000-8000-000000000000", "--name", "x", "--out", out], () => {})).rejects.toThrow(/not found/);
  });

  it("cleanExport never keeps the real name even if a text contains it", () => {
    const d = cleanExport(
      {
        anchorMs: Date.parse("2026-11-10T06:00:00Z"),
        serverName: "Pi (test history)",
        server: { id: "3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", name: "Pi (test history)", slug: "pi-test-history" } as never,
        series: {},
        incidents: [],
        findings: [],
        pluginNames: [],
        worldNames: [],
      },
      { name: "Creeper Hollow SMP", source: "pi-test-history" },
    );
    expect(JSON.stringify(d)).not.toMatch(/test history/i);
    expect((d.server as { slug: string }).slug).toBe("creeper-hollow-smp");
  });
});

describe("committed demo dataset", () => {
  const path = join(repoRoot(), DEMO_DATASET_PATH);
  it.runIf(existsSync(path))(`${DEMO_DATASET_PATH} is clean (schemaVersion, fake ids only, no IPs/names/plugins, relative times)`, () => {
    const text = readFileSync(path, "utf8");
    expect(datasetProblems(text)).toEqual([]);
    expect(Buffer.byteLength(text)).toBeLessThan(1_500_000);
  });
});
