import { demoDatasetMeta, finding, incidentDetail, serverDetail } from "@tickdoctor/shared";
import { ALLOWED_PLUGINS, FAKE_UUID_RE } from "../src/demo/export.js";

// Checks a demo dataset (the committed file or a fresh export) for anything private. Returns a list of problems.

/** Real names that must never appear (the Pi history server, Michel's server, plugins seen on the Pi or in tests). */
export const FORBIDDEN = [
  "Pi (test history)",
  "Overleven",
  "ViaVersion",
  "ViaBackwards",
  "ServerTelemetry",
  "LuckPerms",
  "EssentialsX",
  "michel",
  "td_live_",
  "Model B",
  "rpt-rpi",
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;
const HASH_RE = /\b[0-9a-f]{32,64}\b/i;
const PLUGIN_OK = (name: string) => ALLOWED_PLUGINS.some((p) => p.toLowerCase() === name.toLowerCase()) || /^Plugin [A-Z]+$/.test(name);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking parsed JSON
type J = any;

export function datasetProblems(text: string, extraForbidden: string[] = []): string[] {
  const out: string[] = [];
  let d: J;
  try {
    d = JSON.parse(text);
  } catch {
    return ["not JSON"];
  }
  const meta = demoDatasetMeta.safeParse(d.meta);
  if (!meta.success) out.push("meta does not match demoDatasetMeta");
  if (d.meta?.schemaVersion !== 1) out.push("schemaVersion is not 1");

  for (const m of text.match(UUID_RE) ?? []) if (!FAKE_UUID_RE.test(m)) out.push(`real-looking UUID ${m}`);
  if (ISO_RE.test(text)) out.push("absolute ISO timestamp found");
  if (IPV4_RE.test(text)) out.push(`IPv4 address found: ${IPV4_RE.exec(text)![0]}`);
  if (IPV6_RE.test(text)) out.push("IPv6 address found");
  if (HASH_RE.test(text)) out.push("hash-like hex string found (player id?)");
  for (const f of [...FORBIDDEN, ...extraForbidden]) if (text.toLowerCase().includes(f.toLowerCase())) out.push(`forbidden name "${f}"`);

  // Relative times: every value under a time key is a number (or null), and so is every metric point's first item.
  const timeKeys = new Set<string>(Array.isArray(d.timeKeys) ? d.timeKeys : []);
  if (timeKeys.size === 0) out.push("timeKeys missing");
  const walk = (v: J, key?: string) => {
    if (key && timeKeys.has(key) && v !== null && typeof v !== "number" && typeof v !== "object") out.push(`time key ${key} is not a number`);
    if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(d);
  for (const [m, pts] of Object.entries(d.series?.metrics ?? {})) {
    for (const p of pts as J[]) if (typeof p[0] !== "number") out.push(`series ${m}: time is not a number`);
  }

  // Structure: the shapes the web reuses, with times turned back into ISO strings.
  const toIso = (v: J, key?: string): J => {
    if (key && timeKeys.has(key) && typeof v === "number") return new Date(Date.now() - v * 1000).toISOString();
    if (Array.isArray(v)) return v.map((x) => toIso(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toIso(x, k)]));
    return v;
  };
  if (!serverDetail.safeParse(toIso(d.server)).success) out.push("server does not match serverDetail");
  const host = d.server?.info?.host;
  if (host) {
    if (!["Linux", "Windows", "macOS", "Other"].includes(host.os)) out.push(`host os not generic: ${host.os}`);
    if (host.cpuModel !== undefined && !/^(ARM64|x86-64|ARM|CPU), \d+ cores?$/.test(host.cpuModel)) out.push(`cpu model not generic: ${host.cpuModel}`);
    if (host.memTotalBytes % 1024 ** 3 !== 0) out.push("memTotalBytes not rounded to whole GB");
  }
  for (const i of d.incidents ?? []) if (!incidentDetail.safeParse(toIso(i)).success) out.push("an incident does not match incidentDetail");
  for (const f of d.findings ?? []) if (!finding.safeParse(toIso(f)).success) out.push("a finding does not match Finding");

  // Plugin names in the places that carry them.
  for (const i of d.incidents ?? []) {
    for (const it of i.whatChanged?.items ?? []) if (it.kind === "plugin" && !PLUGIN_OK(it.key)) out.push(`plugin name ${it.key} in what-changed`);
    for (const t of i.timeline ?? []) {
      const m = /^Plugin (.+?) (?:\S+ installed|updated|removed)/.exec(t.label);
      if (m && !PLUGIN_OK(m[1]!) && !PLUGIN_OK(`Plugin ${m[1]}`)) out.push(`plugin name in timeline: ${t.label}`);
    }
  }
  // World names: only the defaults or world_N.
  const worldOk = (w: string) => /^(world|world_nether|world_the_end|world_\d+)$/.test(w);
  const worldWalk = (v: J, key?: string) => {
    if (key === "world" && typeof v === "string" && !worldOk(v)) out.push(`world name ${v}`);
    if (Array.isArray(v)) v.forEach((x) => worldWalk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) worldWalk(x, k);
  };
  worldWalk(d);
  for (const i of d.incidents ?? []) for (const w of i.snapshot?.worlds ?? []) if (!worldOk(w.name)) out.push(`world name ${w.name}`);
  return out;
}
