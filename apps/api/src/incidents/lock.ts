import { sql } from "drizzle-orm";
import { rows, type Exec } from "../db/query.js";

// The per-server detector lock (row lock on server_analysis_state). Separate module so ingest/storage.ts can take
// it before inserting samples without importing the detector (which imports storage).

export interface StateRow {
  watermark: Date | null;
  streak_start: Date | null;
  streak_peak: number | null;
  tps_streak_start: Date | null;
  tps_streak_min: number | null;
  tps_streak_peak: number | null;
}

/** Creates (if needed) and row-locks the server's analysis state. Every detector write path calls this first. */
export async function lockServerState(tx: Exec, serverId: string): Promise<StateRow> {
  await tx.execute(sql`insert into server_analysis_state (server_id) values (${serverId}) on conflict do nothing`);
  const [st] = await rows<StateRow>(
    tx,
    sql`select detector_watermark as watermark, streak_start, streak_peak, tps_streak_start, tps_streak_min, tps_streak_peak
          from server_analysis_state where server_id = ${serverId} for update`,
  );
  return st!;
}
