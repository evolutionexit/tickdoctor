// (b) No findings on healthy seed windows: both demo servers, ~30 days, all hours (incl. evening peaks and
// weekends), server scope in raw 10 s and 1-min shapes, incident scope with a short synthetic incident.
// Documented exception: the seed's Pi really runs -Xms1G -Xmx3G without GC flags, so jvm-flags
// "xms-ne-xmx" and "aikar-flags-missing" are correct there, as severity "info" tuning tips (asserted).
import { describe, expect, test } from "vitest";
import { DEMO_SERVERS } from "../../src/seed.js";
import { H, MIN, assertValid, makeIncident, nearEpisode, runAll, seedBaseline, seedCtx, sliceMinutes, summary, type ServerKey } from "./helpers.js";

const ANCHORS = [Date.parse("2026-11-09T12:00:00Z"), Date.parse("2026-11-08T23:00:00Z")];
const ALLOWED: Record<ServerKey, Set<string>> = {
  pi: new Set(["jvm-flags/xms-ne-xmx", "jvm-flags/aikar-flags-missing"]),
  smp: new Set(),
};
/** Windows every 5 h 17 min: walks through every hour of the day and every weekday over 29 days. */
const STEP = 5 * H + 17 * MIN;

function windows(server: ServerKey, anchor: number) {
  const out: number[] = [];
  for (let t = anchor - 29 * 24 * H; t < anchor; t += STEP) if (!nearEpisode(server, t, anchor)) out.push(t);
  return out;
}
/** Windows that a correct detector wouldn't call healthy are excluded (none expected with the current seed). */
const lagFree = (server: ServerKey, anchor: number, t: number) => sliceMinutes(server, anchor, t - 40 * MIN, t).every((s) => (s.m.mspt_p95 ?? 0) < 50);

describe.each(["pi", "smp"] as ServerKey[])("healthy seed windows: %s", (server) => {
  for (const anchor of ANCHORS) {
    const label = new Date(anchor).toISOString();
    test(`server scope, raw + rollup shapes (anchor ${label})`, () => {
      const ws = windows(server, anchor);
      const usable = ws.filter((t) => lagFree(server, anchor, t));
      expect(usable.length).toBeGreaterThan(ws.length * 0.95);
      expect(usable.length).toBeGreaterThan(80); // SMP loses ~7 days to the heap-pressure week
      const unexpected: string[] = [];
      let peakWindows = 0;
      for (const t of usable) {
        for (const raw of [true, false]) {
          const ctx = seedCtx({ server, anchor, to: t, raw });
          if ((ctx.samples.at(-1)?.m.players ?? 0) >= (server === "pi" ? 6 : 14)) peakWindows++;
          for (const f of runAll(ctx)) {
            assertValid(f);
            // The only allowed findings are info-level tuning tips (review M6).
            if (!ALLOWED[server].has(`${f.ruleId}/${f.dedupKey}`) || f.severity !== "info") unexpected.push(`${new Date(t).toISOString()} raw=${raw}: ${summary([f])}`);
          }
        }
      }
      expect(peakWindows).toBeGreaterThan(10); // the sweep really covers busy evenings
      expect(unexpected).toEqual([]);
    }, 120_000);

    test(`incident scope with a synthetic short incident (anchor ${label})`, () => {
      const unexpected: string[] = [];
      for (const t of windows(server, anchor).filter((_, i) => i % 3 === 0).filter((t) => lagFree(server, anchor, t))) {
        const inc = makeIncident(DEMO_SERVERS[server].id, t - 4 * MIN, t - MIN, 55, seedBaseline(server, t - 4 * MIN, anchor));
        for (const raw of [true, false]) {
          for (const f of runAll(seedCtx({ server, anchor, to: t, scope: "incident", incident: inc, raw }))) {
            assertValid(f);
            // The only allowed findings are info-level tuning tips (review M6).
            if (!ALLOWED[server].has(`${f.ruleId}/${f.dedupKey}`) || f.severity !== "info") unexpected.push(`${new Date(t).toISOString()} raw=${raw}: ${summary([f])}`);
          }
        }
      }
      expect(unexpected).toEqual([]);
    }, 180_000);
  }
});

test("the documented exception really fires on the seed Pi (and only for the Pi)", () => {
  const anchor = ANCHORS[0]!;
  const pi = summary(runAll(seedCtx({ server: "pi", anchor, to: anchor - 20 * H })));
  expect(pi.sort()).toEqual(["jvm-flags/aikar-flags-missing/info", "jvm-flags/xms-ne-xmx/info"]);
  expect(runAll(seedCtx({ server: "smp", anchor, to: anchor - 20 * H }))).toEqual([]);
});
