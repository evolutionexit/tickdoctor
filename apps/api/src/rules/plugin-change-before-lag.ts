// Rule 3: a plugin was added, updated or removed shortly before the server got slower. Scope "incident".
//
// "Shortly before" is not enough on its own: plugins change all the time without consequences. The rule fires
// only if ticks got measurably slower *after* the change at the *same player counts*, comparing 1-min history
// before the change with history after it. The incident itself is left out of that comparison whenever there
// is enough other data after the change, so an unrelated incident (an entity pile, heat) that happens to
// follow a harmless update doesn't blame the plugin.
import type { RuleContext, RuleEvent, RuleFinding, RuleSample } from "./types.js";
import { H_MS, MIN_MS, ago, defineRule, fmt1, isNum, iso, median, ms, plainName, round, steps, val } from "./util.js";

/** Changes up to 72 h before the incident: a regression that only shows at peak hours may need a day or two. */
const LOOKBACK_MS = 72 * H_MS;
/**
 * Changes up to 15 min *after* the detector's start still count: a restart with a new plugin often is what
 * opens the incident (the detector dates the start to the first slow sample, which can precede the event).
 */
const AFTER_START_MS = 15 * MIN_MS;
/** Ignore the minutes right around a change/restart (startup is always slow). */
const SETTLE_MS = 10 * MIN_MS;
/** Before-period: up to 7 days before the change. */
const BEFORE_MS = 7 * 24 * H_MS;
/** Per player count we need ≥ 5 minutes on each side, and ≥ 20 matched minutes after the change in total. */
const MIN_BUCKET = 5;
const MIN_MATCHED_AFTER = 20;
const MIN_BEFORE = 60;
/** If there's not enough data outside the incident, the incident may be used only if the change was ≤ 3 h before it. */
const TIGHT_MS = 3 * H_MS;
/** Slower by ≥ 4 ms average tick time and ≥ 25 %: day-to-day noise on a steady server stays below this. */
const MIN_DELTA_MS = 4;
const MIN_DELTA_SHARE = 0.25;

type Change = { kind: "updated" | "added" | "removed"; name: string; from?: string; to?: string; ts: number };

function collectChanges(ctx: RuleContext, from: number, to: number): Change[] {
  const out: Change[] = [];
  for (const e of Array.isArray(ctx.events) ? ctx.events : []) {
    if (e?.type !== "plugins_changed") continue;
    const t = ms(e.ts);
    if (!(t >= from && t <= to)) continue;
    for (const u of e.updated ?? []) out.push({ kind: "updated", name: u.name, from: u.from, to: u.to, ts: t });
    for (const a of e.added ?? []) out.push({ kind: "added", name: a.name, to: a.version, ts: t });
    for (const r of e.removed ?? []) out.push({ kind: "removed", name: r.name, from: r.version, ts: t });
  }
  // Fallback: plugin inventory history (e.g. events lost). A version first seen in the window, while the
  // agent already knew the server before (not its very first inventory), is an add or update.
  const inv = Array.isArray(ctx.plugins) ? ctx.plugins : [];
  const firstEver = Math.min(...inv.map((p) => ms(p.firstSeen)).filter(isNum));
  for (const p of inv) {
    const t = ms(p.firstSeen);
    if (!(t >= from && t <= to) || !(t > firstEver + H_MS)) continue;
    if (out.some((c) => c.name.toLowerCase() === p.name.toLowerCase() && Math.abs(c.ts - t) <= 2 * H_MS)) continue;
    const prev = inv
      .filter((q) => q.name === p.name && q.version !== p.version && ms(q.firstSeen) < t)
      .sort((a, b) => ms(b.lastSeen) - ms(a.lastSeen))[0];
    out.push(prev ? { kind: "updated", name: p.name, from: prev.version, to: p.version, ts: t } : { kind: "added", name: p.name, to: p.version, ts: t });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Restart periods to skip (startup is slow on any server). */
function startTimes(events: RuleEvent[]): number[] {
  return events.filter((e) => e?.type === "server_start").map((e) => ms(e.ts)).filter(isNum);
}

function matchedDelta(before: RuleSample[], after: RuleSample[]) {
  const bucket = (ss: RuleSample[]) => {
    const m = new Map<number, number[]>();
    for (const s of ss) {
      const p = val(s, "players");
      const v = val(s, "mspt_avg");
      if (p === undefined || v === undefined) continue;
      const k = Math.round(p);
      (m.get(k) ?? m.set(k, []).get(k)!).push(v);
    }
    return m;
  };
  const b = bucket(before);
  const a = bucket(after);
  let w = 0;
  let sumDelta = 0;
  let sumBefore = 0;
  let sumAfter = 0;
  for (const [k, av] of a) {
    const bv = b.get(k);
    if (!bv || bv.length < MIN_BUCKET || av.length < MIN_BUCKET) continue;
    const mb = median(bv)!;
    const ma = median(av)!;
    w += av.length;
    sumDelta += (ma - mb) * av.length;
    sumBefore += mb * av.length;
    sumAfter += ma * av.length;
  }
  if (w === 0) return null;
  return { matched: w, delta: sumDelta / w, before: sumBefore / w, after: sumAfter / w };
}

function evaluate(ctx: RuleContext): RuleFinding[] {
  if (ctx.scope !== "incident" || !ctx.incident) return [];
  const start = ms(ctx.incident.startedAt);
  const end = ctx.incident.endedAt ? ms(ctx.incident.endedAt) : ms(ctx.window?.to ?? ctx.now);
  if (!isNum(start)) return [];
  const changes = collectChanges(ctx, start - LOOKBACK_MS, start + AFTER_START_MS);
  if (changes.length === 0) return [];

  // Group changes made together (within 15 min) into batches, newest first.
  const batches: Change[][] = [];
  for (const c of changes) {
    const last = batches[batches.length - 1];
    if (last && Math.abs(last[0]!.ts - c.ts) <= 15 * MIN_MS) last.push(c);
    else batches.push([c]);
  }

  // Minute history plus the window (dedupe by ts).
  const seen = new Set<string>();
  const series: RuleSample[] = [];
  for (const s of [...(ctx.history ?? []), ...(ctx.samples ?? [])]) {
    if (!s?.ts || seen.has(s.ts)) continue;
    seen.add(s.ts);
    series.push(s);
  }
  const starts = startTimes(ctx.events ?? []);
  const settled = (t: number) => !starts.some((st) => t >= st && t < st + SETTLE_MS);

  for (const batch of batches) {
    const t = batch[0]!.ts;
    const before = series.filter((s) => {
      const x = ms(s.ts);
      return x >= t - BEFORE_MS && x < t - SETTLE_MS && settled(x);
    });
    if (before.length < MIN_BEFORE) continue;
    const outside = series.filter((s) => {
      const x = ms(s.ts);
      return x >= t + SETTLE_MS && x < start - SETTLE_MS && settled(x); // empty when the change opened the incident
    });
    let res = matchedDelta(before, outside);
    let usedIncident = false;
    if ((!res || res.matched < MIN_MATCHED_AFTER) && start - t <= TIGHT_MS) {
      // (start - t is negative when the change came right after the detector's start)
      const incl = series.filter((s) => {
        const x = ms(s.ts);
        return x >= t + SETTLE_MS && x <= end && settled(x);
      });
      res = matchedDelta(before, incl);
      usedIncident = true;
    }
    if (!res || res.matched < MIN_MATCHED_AFTER) continue;
    if (res.delta < Math.max(MIN_DELTA_MS, MIN_DELTA_SHARE * res.before)) continue;
    return [finding(ctx, batch, res, start, end, usedIncident)];
  }
  return [];
}

function describe(c: Change): string {
  if (c.kind === "updated") return `${c.name} ${c.from ?? "?"} → ${c.to ?? "?"}`;
  if (c.kind === "added") return `${c.name} ${c.to ?? ""} added`.replace("  ", " ");
  return `${c.name} ${c.from ?? ""} removed`.replace("  ", " ");
}

function finding(
  ctx: RuleContext,
  batch: Change[],
  res: { delta: number; before: number; after: number; matched: number },
  start: number,
  end: number,
  usedIncident: boolean,
): RuleFinding {
  const t = batch[0]!.ts;
  // dedupKey keeps the raw names (finding identity); every text below uses the plainName copies.
  const names = [...new Set(batch.map((c) => c.name))].sort((a, b) => a.localeCompare(b));
  batch = batch.map((c) => ({
    ...c,
    name: plainName(c.name),
    ...(c.from !== undefined ? { from: plainName(c.from) } : {}),
    ...(c.to !== undefined ? { to: plainName(c.to) } : {}),
  }));
  const list = batch.slice(0, 3).map(describe).join(", ") + (batch.length > 3 ? ` and ${batch.length - 3} more` : "");
  const one = batch.length === 1 ? batch[0]! : null;
  const severity = ctx.incident!.peakMsptP95 >= 100 && res.delta >= 10 ? "high" : "medium";
  const what =
    one?.kind === "updated" ? `${one.name} was updated from ${one.from} to ${one.to}` :
    one?.kind === "added" ? `${one.name}${one.to ? ` ${one.to}` : ""} was installed` :
    one?.kind === "removed" ? `${one.name}${one.from ? ` ${one.from}` : ""} was removed` :
    `${batch.length} plugin changes were made (${list})`;

  const fix: (string | null)[] = [];
  fix.push("Make a backup first: copy the whole `plugins` folder somewhere safe.");
  const updated = batch.filter((c) => c.kind === "updated");
  const added = batch.filter((c) => c.kind === "added");
  const removed = batch.filter((c) => c.kind === "removed");
  if (updated.length)
    fix.push(
      `Roll back to test: stop the server and replace ${updated.slice(0, 3).map((c) => `${c.name} ${c.to} with version ${c.from}`).join(", ")} in \`plugins/\`. Keep the plugin's config folder (back it up too, newer versions sometimes rewrite it).`,
    );
  if (added.length) fix.push(`Test without it: stop the server and move ${added.slice(0, 3).map((c) => `the ${c.name} jar`).join(", ")} out of \`plugins/\`.`);
  if (removed.length) fix.push(`${removed.slice(0, 3).map((c) => c.name).join(", ")} may have been keeping the load down (for example by limiting farms or mobs): reinstall it to test.`);
  fix.push("Start the server and watch it for a day with a similar number of players.");
  fix.push(
    "If the lag is gone, stay on the old setup and tell the plugin's author which versions you compared and when the lag shows up; also check the new version's changelog for a new option you can turn off.",
  );
  fix.push("If the lag stays the same, the change wasn't the cause: put the new version back and look at the other findings for this incident.");

  return {
    ruleId: "plugin-change-before-lag",
    dedupKey: `plugins:${names.join("+").toLowerCase()}`.slice(0, 200),
    severity,
    title: one ? `The server got slower after ${one.name} was ${one.kind === "updated" ? "updated" : one.kind === "added" ? "installed" : "removed"}` : "The server got slower after a plugin change",
    explanation:
      `${what} ${t <= start ? `${ago(t, start)} before this lag started` : "right when this lag started"}. ` +
      `Since then the average tick takes ${fmt1(res.after)} ms instead of ${fmt1(res.before)} ms with the same number of players online. That points to this change as the likely cause, but it can't prove it.`,
    evidence: {
      numbers: [
        { label: "Changed", value: list },
        { label: "Average tick time after the change (same player counts)", value: round(res.after, 1), unit: "ms", baseline: round(res.before, 1) },
        { label: "Slower by", value: round(res.delta, 1), unit: "ms" },
        { label: "Hours between the change and the lag", value: round(Math.max(0, start - t) / H_MS, 1), unit: "h" },
        { label: "Minutes compared after the change", value: res.matched },
        ...(usedIncident ? [{ label: "Comparison includes this incident", value: "yes" }] : []),
      ],
      chart: {
        metric: "mspt_avg",
        from: iso(Math.max(t - 24 * H_MS, ms(ctx.window?.from) - 72 * H_MS)),
        to: ctx.window?.to ?? iso(end),
        highlight: { from: iso(t), to: iso(end) },
      },
    },
    suggestedFix: steps(fix),
  };
}

export const pluginChangeBeforeLag = defineRule({ id: "plugin-change-before-lag", scopes: ["incident"], evaluate });
