#!/usr/bin/env node
// TickDoctor simulated players. See README.md. No chat, no commands, no op.
import mineflayer from "mineflayer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["ramp", "idle-crowd", "explorers"];
const MC_VERSION = "26.1";
const MAX_RECONNECTS = 2;
const CONNECT_TIMEOUT_MS = 30_000;
const MIN_GAP_S = 3;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node run.mjs <${SCENARIOS.join("|")}> [--host H] [--port P] [--count N] [--minutes M]
       [--interval S] (ramp: seconds between joins, default 60, min ${MIN_GAP_S})
       [--stagger S]  (other scenarios: seconds between joins, default ${MIN_GAP_S}, min ${MIN_GAP_S})
       [--dry-run]`);
  process.exit(2);
}

function parseArgs(argv) {
  const a = { scenario: null, host: process.env.TD_BOT_HOST || "", port: 25565, count: null, minutes: 10, interval: 60, stagger: MIN_GAP_S, dryRun: false };
  const rest = argv.slice(2);
  if (process.env.TD_BOT_PORT) a.port = Number(process.env.TD_BOT_PORT);
  const num = (name, v, min, max) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < min || n > max) usage(`--${name} must be a number in [${min}, ${max}]`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith("--")) {
      if (a.scenario) usage(`unexpected argument ${t}`);
      a.scenario = t;
      continue;
    }
    const k = t.slice(2);
    if (k === "dry-run") { a.dryRun = true; continue; }
    const v = rest[++i];
    if (k === "host") { if (!v) usage("--host needs a value"); a.host = v; }
    else if (k === "port") a.port = num(k, v, 1, 65535);
    else if (k === "count") a.count = num(k, v, 1, 99);
    else if (k === "minutes") a.minutes = num(k, v, 0.1, 240);
    else if (k === "interval") a.interval = num(k, v, MIN_GAP_S, 3600);
    else if (k === "stagger") a.stagger = num(k, v, MIN_GAP_S, 600);
    else usage(`unknown option ${t}`);
  }
  if (!a.scenario) usage("missing scenario");
  if (!SCENARIOS.includes(a.scenario)) usage(`unknown scenario ${a.scenario}`);
  if (a.count === null) a.count = { ramp: 12, "idle-crowd": 8, explorers: 3 }[a.scenario];
  return a;
}

const args = parseArgs(process.argv);
if (!args.host) usage("no host: pass --host or set TD_BOT_HOST (see your local notes)");
const gap = args.scenario === "ramp" ? args.interval : args.stagger;
const names = Array.from({ length: args.count }, (_, i) => `TDBot${String(i + 1).padStart(2, "0")}`);
const joinOffsetsS = names.map((_, i) => i * gap);
const lastJoinS = joinOffsetsS[joinOffsetsS.length - 1];
const holdS = args.minutes * 60;
// ramp: --minutes is the hold AFTER the last bot joined; others: hold after last join too.
const plannedTotalS = lastJoinS + holdS;
const hardTimeoutS = plannedTotalS + 5 * 60;

function printPlan() {
  log(`plan: scenario=${args.scenario} target=${args.host}:${args.port} version=${MC_VERSION} auth=offline bots=${args.count}`);
  log(`plan: join gap ${gap}s, last join at +${lastJoinS}s, hold ${holdS}s after last join, planned total ${Math.round(plannedTotalS)}s`);
  log(`plan: hard global timeout ${Math.round(hardTimeoutS)}s (planned total + 5 min), max ${MAX_RECONNECTS} reconnects per bot`);
  names.forEach((n, i) => log(`plan: ${n} joins at +${joinOffsetsS[i]}s behaviour=${behaviourName(i)}`));
}
function behaviourName(i) {
  if (args.scenario === "idle-crowd") return "stand-still";
  if (args.scenario === "explorers") return `straight-line yaw=${Math.round((i * 360) / args.count)}deg sprint`;
  return "random-walk";
}

if (args.dryRun) {
  printPlan();
  log("dry-run: not connecting");
  process.exit(0);
}

// ---- state ----
const startedAt = new Date();
const records = names.map((name, i) => ({ name, behaviour: behaviourName(i), sessions: [], kicks: [], errors: [], reconnects: 0 }));
const live = new Map(); // name -> { bot, timers }
let shuttingDown = false;
const globalTimers = [];

function onlineBots() {
  return [...live.values()].filter((l) => l.spawned).map((l) => l.bot);
}

function startBehaviour(entry, i) {
  const { bot } = entry;
  const scenario = args.scenario;
  if (scenario === "idle-crowd") return;
  const t = (fn, ms) => { const h = setInterval(fn, ms); entry.timers.push(h); return h; };
  const to = (fn, ms) => { const h = setTimeout(fn, ms); entry.timers.push(h); return h; };

  let lastPos = null;
  let stuckTicks = 0;
  const checkBlocked = () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (lastPos && p.distanceTo(lastPos) < 0.05) stuckTicks++; else stuckTicks = 0;
    lastPos = p.clone();
    if (stuckTicks >= 2) {
      bot.setControlState("jump", true);
      to(() => bot.setControlState("jump", false), 400);
      if (scenario === "explorers" && stuckTicks >= 12) { // wall we cannot hop: turn a bit
        bot.look(bot.entity.yaw + rnd(0.8, 2.4), 0, true).catch(() => {});
        stuckTicks = 0;
      }
    }
  };

  if (scenario === "explorers") {
    const yaw = (i * 2 * Math.PI) / args.count;
    bot.look(yaw, 0, true).catch(() => {});
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    t(checkBlocked, 500);
    return;
  }

  // ramp: random walk
  bot.setControlState("forward", true);
  t(checkBlocked, 500);
  const turn = () => {
    bot.look(rnd(-Math.PI, Math.PI), rnd(-0.2, 0.2), false).catch(() => {});
    bot.setControlState("sprint", Math.random() < 0.3);
    to(turn, rnd(2000, 7000));
  };
  turn();
}

function stopTimers(entry) {
  for (const h of entry.timers) { clearInterval(h); clearTimeout(h); }
  entry.timers = [];
}

function connect(i, attempt = 0) {
  const rec = records[i];
  const name = rec.name;
  const entry = { bot: null, timers: [], spawned: false, session: null, ended: false, quitting: false };
  let bot;
  try {
    bot = mineflayer.createBot({
      host: args.host, port: args.port, username: name, auth: "offline", version: MC_VERSION,
      hideErrors: true, respawn: true, checkTimeoutInterval: 30_000,
    });
  } catch (e) {
    rec.errors.push({ t: new Date().toISOString(), message: String(e?.message ?? e) });
    log(`error ${name} createBot failed: ${e?.message ?? e}`);
    return Promise.resolve();
  }
  entry.bot = bot;
  live.set(name, entry);

  return new Promise((resolve) => {
    const finish = () => {
      if (entry.ended) return;
      entry.ended = true;
      stopTimers(entry);
      if (entry.session && !entry.session.leftAt) {
        entry.session.leftAt = new Date().toISOString();
        log(`left ${name} reason=${entry.quitting ? "client-quit" : "disconnected"}`);
      }
      live.delete(name);
      const unexpected = !entry.quitting && !shuttingDown;
      if (unexpected && rec.reconnects < MAX_RECONNECTS) {
        rec.reconnects++;
        log(`reconnect ${name} attempt ${rec.reconnects}/${MAX_RECONNECTS} in 10s`);
        const h = setTimeout(() => { if (!shuttingDown) connect(i, attempt + 1); resolve(); }, 10_000);
        globalTimers.push(h);
        return;
      }
      if (unexpected) log(`giveup ${name} after ${rec.reconnects} reconnects`);
      resolve();
    };
    entry.finish = finish;

    const connTimer = setTimeout(() => {
      if (!entry.spawned) {
        const msg = `connect timeout after ${CONNECT_TIMEOUT_MS / 1000}s`;
        rec.errors.push({ t: new Date().toISOString(), message: msg });
        log(`error ${name} ${msg}`);
        try { bot.end("connect-timeout"); } catch {}
        setTimeout(finish, 500);
      }
    }, CONNECT_TIMEOUT_MS);
    entry.timers.push(connTimer);

    bot.once("spawn", () => {
      clearTimeout(connTimer);
      entry.spawned = true;
      entry.session = { joinedAt: new Date().toISOString(), leftAt: null };
      rec.sessions.push(entry.session);
      log(`joined ${name}`);
      startBehaviour(entry, i);
    });
    bot.on("death", () => {
      log(`death ${name} (respawning)`);
      setTimeout(() => { try { bot.respawn(); } catch {} }, 1000);
    });
    bot.on("kicked", (reason) => {
      let text = reason;
      try { text = typeof reason === "string" ? reason : JSON.stringify(reason); } catch {}
      rec.kicks.push({ t: new Date().toISOString(), reason: text });
      log(`kicked ${name} reason=${text}`);
    });
    bot.on("error", (e) => {
      rec.errors.push({ t: new Date().toISOString(), message: String(e?.message ?? e) });
      log(`error ${name} ${e?.code ?? ""} ${e?.message ?? e}`);
    });
    bot.on("end", (reason) => {
      if (!entry.quitting) log(`end ${name} reason=${reason}`);
      finish();
    });
  });
}

async function quitAll(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${why}; quitting ${live.size} bots`);
  globalTimers.forEach((h) => { clearTimeout(h); clearInterval(h); });
  const waits = [];
  for (const [name, entry] of [...live]) {
    entry.quitting = true;
    stopTimers(entry);
    waits.push(new Promise((res) => {
      const done = () => { entry.finish?.(); res(); };
      entry.bot.once("end", done);
      try { entry.bot.clearControlStates(); entry.bot.quit("done"); } catch { done(); }
      setTimeout(() => { try { entry.bot._client?.end?.("timeout"); } catch {} done(); }, 5000);
    }));
    await sleep(300); // gentle, avoids a burst of leave events
  }
  await Promise.all(waits);
}

function writeSummary(why) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "out");
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${args.scenario}-${stamp}.json`);
  const summary = {
    scenario: args.scenario, host: args.host, port: args.port, version: MC_VERSION, count: args.count,
    startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), endReason: why,
    joinGapSeconds: gap, holdMinutes: args.minutes, bots: records,
  };
  writeFileSync(file, JSON.stringify(summary, null, 2));
  log(`summary written ${file}`);
}

let ending = false;
async function endRun(why, code = 0) {
  if (ending) return;
  ending = true;
  await quitAll(why);
  writeSummary(why);
  process.exit(code);
}

process.on("SIGINT", () => endRun("SIGINT", 130));
process.on("SIGTERM", () => endRun("SIGTERM", 143));
process.on("uncaughtException", (e) => { log(`uncaughtException ${e?.stack ?? e}`); endRun("uncaughtException", 1); });
process.on("unhandledRejection", (e) => { log(`unhandledRejection ${e?.stack ?? e}`); });

// ---- run ----
printPlan();
log("start (no chat, no commands)");

globalTimers.push(setTimeout(() => { log("HARD TIMEOUT reached"); endRun("hard-timeout", 3); }, hardTimeoutS * 1000));

globalTimers.push(setInterval(() => {
  const on = onlineBots();
  const pings = on.map((b) => b.player?.ping).filter((p) => Number.isFinite(p));
  const avg = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : "n/a";
  log(`summary online=${on.length}/${args.count} avgPing=${avg}${pings.length ? "ms" : ""}`);
}, 30_000));

for (let i = 0; i < names.length; i++) {
  globalTimers.push(setTimeout(() => { if (!shuttingDown) connect(i); }, joinOffsetsS[i] * 1000));
}
globalTimers.push(setTimeout(() => endRun("completed"), plannedTotalS * 1000));
