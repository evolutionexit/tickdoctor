ALTER TABLE "server_analysis_state" ADD COLUMN "tps_streak_peak" double precision;--> statement-breakpoint
-- Incidents created before 0003 have no min_tps_1m: fill it from their samples (raw) or 1-min rollups, then
-- recompute severity as the worse of peak p95 and lowest TPS (contracts §6.1). Indexed range reads per incident.
UPDATE "incidents" i SET "min_tps_1m" = CASE WHEN i."source" = 'raw'
    THEN (SELECT min(s."tps_1m") FROM "metric_samples" s WHERE s."server_id" = i."server_id" AND s."ts" >= i."started_at" AND s."ts" <= coalesce(i."ended_at", now()))
    ELSE (SELECT min(r."tps_1m_min") FROM "metric_rollups_1m" r WHERE r."server_id" = i."server_id" AND r."bucket" >= i."started_at" AND r."bucket" < coalesce(i."ended_at", now()))
  END
 WHERE i."min_tps_1m" IS NULL;--> statement-breakpoint
UPDATE "incidents" SET "severity" = CASE
    WHEN "peak_mspt_p95" >= 250 OR "min_tps_1m" < 10 THEN 'critical'
    WHEN "peak_mspt_p95" >= 100 OR "min_tps_1m" < 15 THEN 'high'
    ELSE 'medium' END
 WHERE "min_tps_1m" IS NOT NULL;
