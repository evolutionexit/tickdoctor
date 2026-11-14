// Rule 10: a plugin throwing the same errors over and over. Scopes "server" (a broken plugin is worth knowing
// about even when the server keeps up) and "incident" (errors during the lag: writing thousands of error
// reports to the log costs main-thread time, and the broken feature may be what's slow).
//
// Never shows exception messages: they can contain player names. Only the plugin, the error class and the
// first stack frame (code location).
import type { RuleContext, RuleEvent, RuleFinding } from "./types.js";
import { chart, defineRule, focusPeriod, fmtInt, isNum, lagging, ms, plainName, round, steps } from "./util.js";

/**
 * Server scope (30 min window): ≥ 100 errors (more than 3 a minute) spread over ≥ 5 different minutes, so a
 * one-off burst at startup or a single failed command doesn't count. Incident scope: ≥ 50 over ≥ 3 minutes
 * (the period is shorter).
 */
const MIN_COUNT = { server: 100, incident: 50 } as const;
const MIN_MINUTES = { server: 5, incident: 3 } as const;
/** ≥ 1,000 per 30 min (≈ 30 a minute) is a flood: medium even without lag. */
const FLOOD_PER_MIN = 30;

type ExceptionEvent = Extract<RuleEvent, { type: "exception" }>;

/** Plain-language gloss for the error kinds owners see most. */
const GLOSS: Record<string, string> = {
  NullPointerException: "the plugin looked for something that wasn't there",
  IllegalArgumentException: "the plugin was handed a value it can't use",
  IllegalStateException: "the plugin got into a state it didn't expect",
  ClassCastException: "the plugin got a different kind of object than it expected",
  IndexOutOfBoundsException: "the plugin read past the end of a list",
  ArrayIndexOutOfBoundsException: "the plugin read past the end of a list",
  ConcurrentModificationException: "a list was changed while the plugin was going through it",
  NoSuchMethodError: "the plugin doesn't match your server or another plugin's version",
  NoSuchFieldError: "the plugin doesn't match your server or another plugin's version",
  NoClassDefFoundError: "the plugin needs something that's missing, often another plugin or a newer version",
  ClassNotFoundException: "the plugin needs something that's missing, often another plugin or a newer version",
  UnsupportedOperationException: "the plugin tried something your server version doesn't allow",
  SQLException: "the plugin's database connection or query failed",
  IOException: "reading or writing a file or network connection failed",
};

function evaluate(ctx: RuleContext): RuleFinding[] {
  const scope = ctx.scope === "incident" ? "incident" : "server";
  const p = focusPeriod(ctx);
  const evs = (Array.isArray(ctx.events) ? ctx.events : []).filter(
    (e): e is ExceptionEvent => e?.type === "exception" && ms(e.ts) >= p.from && ms(e.ts) <= p.to,
  );
  if (evs.length === 0) return [];

  // Group by plugin; unattributed errors by stack hash.
  const groups = new Map<string, { plugin?: string; evs: ExceptionEvent[] }>();
  for (const e of evs) {
    const plugin = typeof e.plugin === "string" && e.plugin.trim() ? e.plugin.trim() : undefined;
    const key = plugin ? `plugin:${plugin.toLowerCase()}` : `stack:${e.stackHash ?? e.exceptionClass ?? "unknown"}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...(plugin ? { plugin } : {}), evs: [] }));
    g.evs.push(e);
  }

  const minutes = Math.max(1, (p.to - p.from) / 60_000);
  const lag = lagging(ctx);
  const out: RuleFinding[] = [];
  for (const [key, g] of groups) {
    const count = g.evs.reduce((a, e) => a + (isNum(e.count) && e.count > 0 ? e.count : 1), 0);
    const distinctMinutes = new Set(g.evs.map((e) => Math.floor(ms(e.ts) / 60_000))).size;
    if (count < MIN_COUNT[scope] || distinctMinutes < MIN_MINUTES[scope]) continue;
    const perMin = count / minutes;

    // Most frequent error kind.
    const kinds = new Map<string, { cls: string; frame?: string; n: number }>();
    for (const e of g.evs) {
      const k = e.stackHash ?? e.exceptionClass;
      const cur = kinds.get(k) ?? { cls: e.exceptionClass ?? "unknown error", ...(e.topFrames?.[0] ? { frame: e.topFrames[0] } : {}), n: 0 };
      cur.n += isNum(e.count) ? e.count : 1;
      kinds.set(k, cur);
    }
    const top = [...kinds.values()].sort((a, b) => b.n - a.n)[0]!;
    const rawCls = top.cls.split(".").pop() ?? top.cls;
    const gloss = Object.hasOwn(GLOSS, rawCls) ? GLOSS[rawCls] : undefined;
    // Agent-supplied text below only through plainName (no Markdown / newlines from plugin or class names).
    const cls = plainName(rawCls);
    const rawVersion = g.plugin ? ctx.info?.plugins?.find((x) => x.name.toLowerCase() === g.plugin!.toLowerCase())?.version : undefined;
    const version = rawVersion !== undefined ? plainName(rawVersion) : undefined;
    const plugin = g.plugin !== undefined ? plainName(g.plugin) : undefined;
    const mcVersion = ctx.info?.server?.minecraftVersion ? plainName(ctx.info.server.minecraftVersion) : "";
    // The plugin is a best guess (the agent matches log message patterns and the first stack frame that lies
    // in a plugin's package): a plugin crashing inside another plugin's code, or a shared library package,
    // can point at the wrong one. So the text says "point to", never "X threw".
    const who = plugin
      ? ` They point to the plugin ${plugin}${version ? ` (version ${version})` : ""}; that is a best guess from the error details, so check the log to be sure.`
      : " They couldn't be tied to a specific plugin.";
    const severity = lag ? (perMin >= FLOOD_PER_MIN ? "high" : "medium") : perMin >= FLOOD_PER_MIN ? "medium" : "low";
    const recentChange = (ctx.events ?? []).find(
      (e) =>
        e?.type === "plugins_changed" &&
        g.plugin &&
        ms(e.ts) <= p.to &&
        ms(e.ts) >= p.from - 7 * 86_400_000 &&
        [...(e.added ?? []), ...(e.updated ?? [])].some((x) => x.name.toLowerCase() === g.plugin!.toLowerCase()),
    );

    out.push({
      ruleId: "plugin-exceptions",
      dedupKey: key.slice(0, 200),
      severity,
      title: plugin ? `Errors that point to ${plugin} keep repeating` : "The same error keeps repeating in the server log",
      explanation:
        `The server logged ${fmtInt(count)} errors in ${fmtInt(minutes)} minutes (about ${fmtInt(Math.max(1, perMin))} a minute), mostly \`${cls}\`${gloss ? ` (${gloss})` : ""}.${who} ` +
        "The same thing is failing again and again, so whatever the plugin was trying to do probably isn't working, and writing each error to the log costs the server a little time.",
      evidence: {
        numbers: [
          { label: "Errors in this period", value: count },
          { label: "Errors per minute", value: round(perMin, 1), unit: "/min" },
          { label: "Most common error", value: cls },
          ...(top.frame ? [{ label: "Where in the code", value: plainName(top.frame) }] : []),
          ...(kinds.size > 1 ? [{ label: "Different kinds of errors", value: kinds.size }] : []),
          ...(version ? [{ label: "Plugin version", value: version }] : []),
        ],
        ...(chart(ctx, "mspt_p95") ? { chart: chart(ctx, "mspt_p95") } : {}),
      },
      suggestedFix: steps([
        `Open \`logs/latest.log\` and search for \`${cls}\` to see the full error and what happened just before it${plugin ? `. Check that the lines in it name ${plugin} (its name or its package)` : ""}.`,
        plugin
          ? `Update ${plugin} to its newest version (and check that it supports your Paper version${mcVersion ? `, ${mcVersion}` : ""}).`
          : "The first lines of the error usually name the plugin's package (for example `com.example.someplugin`); that tells you which plugin it is.",
        recentChange && recentChange.type === "plugins_changed" ? `${plugin} changed recently: if the errors started with that change, put the previous version back to test.` : null,
        plugin ? `Check its config (\`plugins/${plugin}/config.yml\`) for a setting that points at something missing (a world, a database, another plugin).` : null,
        plugin ? `If you can't fix it, report the error to the plugin's author, or remove \`${plugin}\` from \`plugins/\` and restart to confirm the errors stop.` : "Report the error to that plugin's author.",
        "When you report it, send the author the error lines copied from the log file as text (not a screenshot).",
      ]),
    });
  }
  return out.sort((a, b) => Number(b.evidence.numbers[0]!.value) - Number(a.evidence.numbers[0]!.value)).slice(0, 5);
}

export const pluginExceptions = defineRule({ id: "plugin-exceptions", scopes: ["server", "incident"], evaluate });
