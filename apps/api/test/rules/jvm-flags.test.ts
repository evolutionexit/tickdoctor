import { describe, expect, test } from "vitest";
import { jvmFlags } from "../../src/rules/jvm-flags.js";
import { GB, MB } from "../../src/rules/util.js";
import { assertValid, handCtx, hello, piHello, rawSeries, healthyM } from "./helpers.js";

const AIKAR = piHello().jvm.flags.filter((f) => !/^-Xm[sx]/.test(f));
const run = (info: ReturnType<typeof piHello> | null) => {
  const fs = jvmFlags.evaluate(handCtx({ samples: rawSeries(3, () => ({ m: healthyM() })), info }));
  fs.forEach(assertValid);
  return fs;
};
const keys = (fs: { dedupKey: string }[]) => fs.map((f) => f.dedupKey).sort();

describe("jvm-flags", () => {
  test("seed Pi profile (-Xms1G -Xmx3G, no GC flags): xms-ne-xmx + aikar-flags-missing", () => {
    const info = hello("pi", Date.now(), Date.now());
    expect(keys(jvmFlags.evaluate(handCtx({ samples: [], info })))).toEqual(["aikar-flags-missing", "xms-ne-xmx"]);
  });

  test("seed SMP profile (6G/6G, partial G1 tuning): nothing", () => {
    expect(jvmFlags.evaluate(handCtx({ samples: [], info: hello("smp", Date.now(), Date.now()) }))).toEqual([]);
  });

  test("-Xms4G -Xmx4G with Aikar's flags on 8 GB: nothing (the planned Pi fix)", () => {
    expect(run(piHello({ flags: ["-Xms4G", "-Xmx4G", ...AIKAR], heapInit: 4 * GB, heapMax: 4 * GB }))).toEqual([]);
  });

  test("units: -Xms4096m equals -Xmx4G", () => {
    expect(run(piHello({ flags: ["-Xms4096m", "-Xmx4G", ...AIKAR], heapInit: 4 * GB, heapMax: 4 * GB }))).toEqual([]);
  });

  test("no -Xmx at all: only xmx-missing (no separate xms finding)", () => {
    const fs = run(piHello({ flags: AIKAR, heapInit: 128 * MB, heapMax: 2 * GB }));
    expect(keys(fs)).toEqual(["xmx-missing"]);
    expect(fs[0]!.suggestedFix).toContain("-Xms2G -Xmx2G");
  });

  test("-XX:MaxRAMPercentage sizing counts as set", () => {
    const fs = run(piHello({ flags: ["-XX:MaxRAMPercentage=50", "-XX:InitialRAMPercentage=50", ...AIKAR], heapInit: 4 * GB, heapMax: 4 * GB }));
    expect(fs).toEqual([]);
  });

  test("Xmx too large for RAM: medium, high when ≥ RAM; suggests a size that fits; no xms finding on top", () => {
    const tight = run(piHello({ flags: ["-Xms7G", "-Xmx7G", ...AIKAR], heapInit: 7 * GB, heapMax: 7 * GB, ram: 8 * GB }));
    expect(tight.map((f) => [f.dedupKey, f.severity])).toEqual([["xmx-too-large-for-ram", "medium"]]);
    expect(tight[0]!.suggestedFix).toContain("-Xmx6G");
    const over = run(piHello({ flags: ["-Xms2G", "-Xmx10G", ...AIKAR], heapInit: 2 * GB, heapMax: 10 * GB, ram: 8 * GB }));
    expect(over.map((f) => [f.dedupKey, f.severity])).toEqual([["xmx-too-large-for-ram", "high"]]);
  });

  test("6G on 8 GB is fine (SMP), 3G on 4 GB is too much", () => {
    expect(run(piHello({ flags: ["-Xms6G", "-Xmx6G", ...AIKAR], heapInit: 6 * GB, heapMax: 6 * GB, ram: 8 * GB }))).toEqual([]);
    expect(keys(run(piHello({ flags: ["-Xms3G", "-Xmx3G", ...AIKAR], heapInit: 3 * GB, heapMax: 3 * GB, ram: 4 * GB })))).toEqual(["xmx-too-large-for-ram"]);
  });

  test("ZGC / Shenandoah chosen on purpose: no Aikar advice", () => {
    expect(run(piHello({ flags: ["-Xms4G", "-Xmx4G", "-XX:+UseZGC", "-XX:+ZGenerational"], heapInit: 4 * GB, heapMax: 4 * GB }))).toEqual([]);
  });

  test("Parallel / Serial GC: slow-gc-collector instead of aikar-flags-missing", () => {
    expect(keys(run(piHello({ flags: ["-Xms4G", "-Xmx4G", "-XX:+UseParallelGC"], heapInit: 4 * GB, heapMax: 4 * GB })))).toEqual(["slow-gc-collector"]);
  });

  test("missing data: no hello, no RAM, empty flags", () => {
    expect(jvmFlags.evaluate(handCtx({ samples: [], info: null }))).toEqual([]);
    const noRam = piHello({ flags: ["-Xms1G", "-Xmx3G", ...AIKAR] });
    delete (noRam.host as { totalMemoryBytes?: number }).totalMemoryBytes;
    const fs = jvmFlags.evaluate(handCtx({ samples: [], info: noRam }));
    expect(keys(fs)).toEqual(["xms-ne-xmx"]);
    expect(fs[0]!.evidence.numbers).toHaveLength(2);
  });
});

describe("jvm-flags: very small heap", () => {
  test("-Xmx768M on 8 GB: xmx-too-small (replaces xms-ne-xmx), suggests 4G", () => {
    const fs = run(piHello({ flags: ["-Xms512M", "-Xmx768M", ...AIKAR], heapInit: 512 * MB, heapMax: 768 * MB, ram: 8 * GB }));
    expect(keys(fs)).toEqual(["xmx-too-small"]);
    expect(fs[0]!.suggestedFix).toContain("`-Xmx768M` and `-Xms512M` to `-Xms4G -Xmx4G`");
  });

  test("a genuinely small machine (768M on a 2 GB VPS) is left alone apart from Xms ≠ Xmx", () => {
    expect(keys(run(piHello({ flags: ["-Xms512M", "-Xmx768M", ...AIKAR], heapInit: 512 * MB, heapMax: 768 * MB, ram: 2 * GB })))).toEqual(["xms-ne-xmx"]);
  });

  test("1G/1G on 8 GB is not 'very small'", () => {
    expect(run(piHello({ flags: ["-Xms1G", "-Xmx1G", ...AIKAR], heapInit: GB, heapMax: GB, ram: 8 * GB }))).toEqual([]);
  });
});
