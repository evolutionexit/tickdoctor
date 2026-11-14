// (c) The real idle Pi (payloads captured 2026-11-09, fixtures/rules/pi-idle/): Paper 26.2 on a Pi 5, full
// Aikar flags but -Xms1G -Xmx3G, view 8 / sim 6, no players, 0 chunks, ~330-480 MB heap used of 3 GB, 8 GB
// RAM, 2 GB zram swap unused, 46 °C, a TickDoctor 0.1.0 → 0.1.1 plugin update minutes before.
// Only jvm-flags "xms-ne-xmx" may fire. This is also the Phase 4 live test: after the switch to 4G/4G it clears.
import { expect, test } from "vitest";
import { RULES } from "../../src/rules/index.js";
import { GB } from "../../src/rules/util.js";
import { assertValid, piHello, piIdleCtx, runAll, summary } from "./helpers.js";

test.each(["server", "incident"] as const)("idle Pi, %s scope: only xms-ne-xmx", (scope) => {
  const fs = runAll(piIdleCtx(scope));
  fs.forEach(assertValid);
  expect(summary(fs)).toEqual(["jvm-flags/xms-ne-xmx/info"]);
});

test("each rule individually on the idle Pi (both scopes)", () => {
  for (const scope of ["server", "incident"] as const) {
    for (const r of RULES) {
      const fs = r.evaluate(piIdleCtx(scope));
      if (r.id === "jvm-flags") expect(fs.map((f) => f.dedupKey)).toEqual(["xms-ne-xmx"]);
      else expect(fs, `${r.id} fired on the idle Pi (${scope})`).toEqual([]);
    }
  }
});

test("live test: after switching the Pi to -Xms4G -Xmx4G the finding stops firing", () => {
  const ctx = piIdleCtx("server");
  const flags = ctx.info!.jvm.flags.map((f) => (f === "-Xms1G" ? "-Xms4G" : f === "-Xmx3G" ? "-Xmx4G" : f));
  ctx.info = piHello({ flags, heapInit: 4 * GB, heapMax: 4 * GB });
  ctx.samples = ctx.samples.map((s) => ({ ...s, m: { ...s.m, heap_max_bytes: 4 * GB } }));
  expect(runAll(ctx)).toEqual([]);
});

test("the xms-ne-xmx finding text for the real Pi", () => {
  const f = runAll(piIdleCtx("server"))[0]!;
  expect(f.title).toBe("Tuning tip: starting memory and maximum memory are different");
  expect(f.severity).toBe("info");
  expect(f.explanation).toContain("isn't why your server lags");
  expect(f.explanation).toContain("starts with 1 GB");
  expect(f.explanation).toContain("grow to 3 GB");
  expect(f.suggestedFix).toContain("`-Xms1G` to `-Xms3G`");
  expect(f.suggestedFix).toContain("only take effect after a restart");
  expect(f.suggestedFix).toContain("-Xms4G -Xmx4G"); // ~60 % of 7.9 GB RAM
  expect(f.evidence.numbers.map((n) => [n.label, n.value])).toEqual([
    ["Starting memory (-Xms)", 1],
    ["Memory limit (-Xmx)", 3],
    ["Machine memory (RAM)", 7.9],
  ]);
});
