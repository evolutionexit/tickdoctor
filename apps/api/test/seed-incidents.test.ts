import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DEMO_SERVERS, EPISODES, seed } from "../src/seed.js";
import { handle, resetStorage } from "./helpers.js";

afterAll(() => handle.close());

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async (query: ReturnType<typeof sql>) => (await handle.db.execute(query)) as unknown as Row[];
const H = 3_600_000;

// The demo must show exactly the four lag episodes as incidents, whatever time of day the seed runs, and nothing
// in healthy time. Two clocks: evening (episodes in busy hours) and early morning (quiet hours).
describe.each([Date.UTC(2026, 10, 9, 18, 0, 3), Date.UTC(2026, 10, 10, 4, 30, 0)])("seed → incidents (now=%s)", (NOW) => {
  it("finds exactly the four episodes, with snapshots/baselines where expected, and runs their rules", async () => {
    await resetStorage();
    const res = await seed(handle.db, { now: NOW });
    const anchor = Date.parse(res.anchor);
    const incs = await q(sql`select i.*, (select count(*)::int from incident_snapshots s where s.incident_id = i.id) as snaps
      from incidents i order by started_at`);
    const matched = new Map<string, Row[]>();
    for (const inc of incs) {
      const s = Date.parse(inc.started_at);
      const e = Date.parse(inc.ended_at);
      const ep = EPISODES.find((x) => DEMO_SERVERS[x.server].id === inc.server_id && s >= anchor + x.startH * H - 60_000 && e <= anchor + x.endH * H + 2 * H);
      expect(ep, `incident ${inc.started_at} → ${inc.ended_at} is outside every episode`).toBeDefined();
      matched.set(ep!.id, [...(matched.get(ep!.id) ?? []), inc]);
    }
    for (const ep of EPISODES) expect(matched.get(ep.id), ep.id).toHaveLength(1);
    const by = (id: string) => matched.get(id)![0]!;
    expect(by("smp-heap-pressure")).toMatchObject({ source: "rollup_1m", snaps: 0 });
    expect(by("pi-plugin-update")).toMatchObject({ source: "rollup_1m", snaps: 0 });
    expect(by("smp-entity-buildup")).toMatchObject({ source: "raw", snaps: 1 });
    expect(by("pi-hot-afternoon")).toMatchObject({ source: "raw", snaps: 1 });
    for (const inc of incs) {
      expect(inc.ended_at).not.toBeNull();
      expect(inc.rules_evaluated_at).not.toBeNull();
      expect(inc.baseline).not.toBeNull();
    }
    const [linked] = await q(sql`select count(*)::int as n from incident_snapshots where incident_id is not null and baseline is not null`);
    expect(linked!.n).toBe(2);
    expect(res.counts.incidents).toBe(4);

    // Findings (real RULES): one per episode, linked to that episode's incident, plus the Pi's jvm-flags
    // (-Xms1G -Xmx3G on purpose). Nothing else, in particular nothing from healthy time.
    const expected: Record<string, string> = {
      "smp-heap-pressure": "gc-pressure",
      "pi-plugin-update": "plugin-change-before-lag",
      "smp-entity-buildup": "entity-explosion",
      "pi-hot-afternoon": "thermal-throttling",
    };
    const fs = await q(sql`select f.server_id, f.rule_id, f.scope, array(select incident_id::text from finding_incidents fi where fi.finding_id = f.id) as incs
      from findings f order by f.rule_id`);
    const incidentFindings = fs.filter((f) => f.scope === "incident");
    expect(incidentFindings).toHaveLength(4);
    for (const [ep, ruleId] of Object.entries(expected)) {
      const f = incidentFindings.find((x) => x.rule_id === ruleId);
      expect(f, ruleId).toBeDefined();
      expect(f!.incs).toEqual([by(ep).id]);
    }
    const serverFindings = fs.filter((f) => f.scope === "server");
    expect(serverFindings.length).toBeGreaterThan(0);
    for (const f of serverFindings) expect([f.server_id, f.rule_id]).toEqual([DEMO_SERVERS.pi.id, "jvm-flags"]);
  }, 300_000);
});
