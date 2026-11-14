import type { Finding, Incident } from "@tickdoctor/shared";

// Plain-text rendering for the CLI (finding:show reads like the owner will see it in the app).

const fmtTime = (s: string | null) => (s ? s.replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace(/Z$/, " UTC") : "-");

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function fmtValue(v: number | string, unit?: string): string {
  const n = typeof v === "number" ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100)) : v;
  return unit ? `${n} ${unit}` : String(n);
}

/** Block coordinates in the middle of a chunk. y is left to the player (~): we only know chunk coordinates. */
export function tpHint(world: string, x: number, z: number): string {
  const bx = x * 16 + 8;
  const bz = z * 16 + 8;
  const dim: Record<string, string> = { world: "minecraft:overworld", world_nether: "minecraft:the_nether", world_the_end: "minecraft:the_end" };
  const d = dim[world];
  return d ? `/execute in ${d} run tp @s ${bx} ~ ${bz}` : `/tp @s ${bx} ~ ${bz}   (in world "${world}")`;
}

export function formatFinding(f: Finding): string[] {
  const out: string[] = [];
  out.push(`[${f.severity.toUpperCase()}] ${f.title}`);
  out.push(`Status: ${f.status.replace("_", " ")}${f.resolvedBy ? ` (resolved by ${f.resolvedBy})` : ""}   ·   rule ${f.ruleId} (${f.scope} scope)   ·   id ${f.id}`);
  out.push("");
  out.push(f.explanation);
  out.push("");
  if (f.evidence.numbers.length) {
    out.push("Evidence:");
    for (const n of f.evidence.numbers) {
      const base = n.baseline !== undefined ? `   (normal: ${fmtValue(n.baseline, n.unit)})` : "";
      out.push(`  - ${n.label}: ${fmtValue(n.value, n.unit)}${base}`);
    }
  }
  if (f.evidence.chart) {
    const c = f.evidence.chart;
    out.push(`Chart: ${c.metric}, ${fmtTime(c.from)} → ${fmtTime(c.to)}${c.highlight ? `, highlighted ${fmtTime(c.highlight.from)} → ${fmtTime(c.highlight.to)}` : ""}`);
  }
  if (f.evidence.chunks?.length) {
    out.push("Chunks to look at:");
    for (const c of f.evidence.chunks) out.push(`  - ${c.world} chunk (${c.x}, ${c.z}):  ${tpHint(c.world, c.x, c.z)}`);
  }
  out.push("");
  out.push("Suggested fix:");
  for (const line of f.suggestedFix.split("\n")) out.push(`  ${line}`);
  out.push("");
  out.push(`First seen ${fmtTime(f.firstSeenAt)} · last seen ${fmtTime(f.lastSeenAt)} · seen ${f.occurrenceCount}×`);
  if (f.markedFixedAt) out.push(`Marked fixed ${fmtTime(f.markedFixedAt)}`);
  if (f.confirmedFixedAt) out.push(`Confirmed fixed ${fmtTime(f.confirmedFixedAt)}`);
  if (f.incidentIds.length) out.push(`Incidents (${f.incidentIds.length}): ${f.incidentIds.slice(-10).join(", ")}${f.incidentIds.length > 10 ? " …" : ""}`);
  return out;
}

export function formatIncidentLine(i: Incident, findingCount?: number): string {
  const dur = i.endedAt ? fmtDuration(Date.parse(i.endedAt) - Date.parse(i.startedAt)) : "ongoing";
  return [
    i.id,
    fmtTime(i.startedAt),
    i.endedAt ? `${dur} (${i.endReason})` : "ongoing",
    i.severity,
    `trigger ${i.trigger}`,
    `peak p95 ${i.peakMsptP95.toFixed(1)} ms`,
    `min TPS ${i.minTps1m === null ? "-" : i.minTps1m.toFixed(1)}`,
    i.source,
    i.snapshotId ? "snapshot" : "no snapshot",
    i.baseline ? "baseline" : "no baseline",
    ...(findingCount !== undefined ? [`${findingCount} findings`] : []),
  ].join("\t");
}

export function formatIncident(i: Incident, findings: Finding[]): string[] {
  const out = [
    `Incident ${i.id} (${i.severity}, opened on ${i.trigger === "tps" ? "low TPS" : "high MSPT"}, source ${i.source})`,
    `Started ${fmtTime(i.startedAt)} · ${i.endedAt ? `ended ${fmtTime(i.endedAt)} (${i.endReason}), ${fmtDuration(Date.parse(i.endedAt) - Date.parse(i.startedAt))}` : "ongoing"}`,
    `Peak MSPT p95: ${i.peakMsptP95.toFixed(1)} ms · lowest TPS: ${i.minTps1m === null ? "-" : i.minTps1m.toFixed(1)}`,
    `Snapshot: ${i.snapshotId ?? "none"} · rules last run ${fmtTime(i.rulesEvaluatedAt)}`,
  ];
  if (i.baseline) {
    const b = i.baseline;
    const p95 = b.metrics.mspt_p95;
    out.push(`Baseline: ${b.healthyMinutes} healthy minutes ${fmtTime(b.from)} → ${fmtTime(b.to)}${p95 ? `, normal p95 ${p95.median} ms (p90 ${p95.p90})` : ""}`);
  } else {
    out.push("Baseline: none (fewer than 30 healthy minutes before it)");
  }
  out.push(`Findings (${findings.length}):`);
  for (const f of findings) out.push(`  - [${f.severity}] ${f.title} (${f.status}) ${f.id}`);
  return out;
}
