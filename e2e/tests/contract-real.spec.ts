import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormatsMod from "ajv-formats";
const addFormats: any = (addFormatsMod as any).default ?? addFormatsMod;
import { helloRequest, metricsRequest, eventsRequest, snapshotRequest } from "../../packages/shared/src/contracts/ingest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(join(here, p), "utf8"));
const jsonSchema = load("../../docs/contracts/ingest.schema.json");
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const zodFor = { hello: helloRequest, metrics: metricsRequest, events: eventsRequest, snapshot: snapshotRequest } as const;
type EP = keyof typeof zodFor;

const bodies = (ep: EP): any[] => load(`../fixtures/pi-real/${ep}.json`).items.map((i: any) => i.body);

for (const ep of Object.keys(zodFor) as EP[]) {
  test(`real Pi ${ep} payloads validate (zod + JSON Schema)`, () => {
    const list = bodies(ep);
    expect(list.length).toBeGreaterThan(0);
    const validate = ajv.compile({ ...jsonSchema.schemas[`${ep}Request`], $defs: undefined });
    list.forEach((b, i) => {
      const z = zodFor[ep].safeParse(b);
      expect(z.success, `zod ${ep}[${i}]: ${z.success ? "" : JSON.stringify(z.error.issues)}`).toBe(true);
      const ok = validate(b);
      expect(ok, `jsonschema ${ep}[${i}]: ${JSON.stringify(validate.errors)}`).toBe(true);
    });
  });
}

test("real data sanity", () => {
  const all = (["hello", "metrics", "events", "snapshot"] as EP[]).flatMap((e) => bodies(e).map((b) => [e, b] as const));
  const text = JSON.stringify(all);
  expect(text).not.toMatch(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/);
  expect(text.replace(/"bootId":"[^"]*"/g, "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text).not.toMatch(/\/home\/|\/Users\//);
  expect(text).not.toMatch(/td_live_[A-Za-z0-9]{10,}/);

  const hello = bodies("hello")[0];
  const flags = JSON.stringify(hello.payload);
  expect(flags).toContain("-Xms1G");
  expect(flags).toContain("-Xmx3G");
  expect(JSON.stringify(hello.payload)).toMatch(/"privacyMode":\s*"hashed"/);
  for (const s of bodies("snapshot")) expect(s.payload.trigger).toBe("requested");

  const items = load("../fixtures/pi-real/metrics.json").items;
  for (const it of items) {
    const b = it.body;
    const ts = b.payload.samples.map((s: any) => Date.parse(s.ts));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThan(ts[i - 1]);
      expect(Math.abs((ts[i] - ts[i - 1]) / 1000 - 10)).toBeLessThan(1);
    }
    expect(ts[ts.length - 1]).toBeLessThanOrEqual(Date.parse(b.sentAt) + 1000);
    expect(Date.parse(b.sentAt) - ts[ts.length - 1]).toBeLessThan(60_000);
    expect(Math.abs(Date.parse(it.receivedAt) - Date.parse(b.sentAt))).toBeLessThan(5000);
    for (const s of b.payload.samples) {
      expect(s.windowSeconds).toBeGreaterThan(8);
      expect(s.windowSeconds).toBeLessThan(12);
      expect(s.tick.msptP95).toBeGreaterThanOrEqual(s.tick.msptAvg);
      expect(s.tick.msptP99).toBeGreaterThanOrEqual(s.tick.msptP95);
      expect(s.jvm.heapUsedBytes).toBeLessThanOrEqual(s.jvm.heapMaxBytes);
    }
  }
});
