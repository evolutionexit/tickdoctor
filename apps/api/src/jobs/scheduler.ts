import type { Db } from "../db/client.js";
import { runRetention } from "./retention.js";
import { runRollup } from "./rollup.js";
import { purgeExpiredAuth, purgePendingUsers } from "../auth/store.js";
import { parseRecheck, type RecheckConfig } from "../env.js";
import type { AlertDispatcher } from "../alerts/dispatcher.js";
import { runIncidentJob, runRecheckJob, runServerRulesJob } from "../findings/jobs.js";

/** Runs a job on an interval; never overlaps itself in-process; timers are unref'd. Tests call the jobs directly. */
function every(name: string, ms: number, job: () => Promise<unknown>, log: (l: string) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      log(`job ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref();
  const first = setTimeout(tick, 5_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

export function startJobs(
  db: Db,
  log: (l: string) => void = console.log,
  recheck: RecheckConfig = parseRecheck(),
  alerts?: Pick<AlertDispatcher, "tick">,
) {
  const stops = [
    ...(alerts ? [every("alerts", 60_000, () => alerts.tick(), log)] : []),
    every("incidents", 15_000, () => runIncidentJob(db, { log }), log),
    every("server-rules", 5 * 60_000, () => runServerRulesJob(db, { log }), log),
    every("recheck", 5 * 60_000, async () => {
      const r = await runRecheckJob(db, recheck);
      if (r && (r.confirmedOwner.length || r.confirmedAuto.length)) log(`recheck confirmed ${JSON.stringify(r)}`);
    }, log),
    every("rollup", 60_000, () => runRollup(db), log),
    every("retention", 3_600_000, async () => {
      const r = await runRetention(db);
      if (!r.skipped) log(`retention deleted ${JSON.stringify(r.deleted)}`);
    }, log),
    every("auth-purge", 3_600_000, async () => {
      await purgeExpiredAuth(db, Date.now());
      const n = await purgePendingUsers(db, Date.now());
      if (n) log(`auth-purge deleted pending_users=${n}`);
    }, log),
  ];
  return () => stops.forEach((s) => s());
}
