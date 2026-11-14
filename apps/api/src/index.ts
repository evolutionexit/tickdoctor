import { serve } from "@hono/node-server";
import { createApp, createLimiters } from "./app.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { configureLimits } from "./limits.js";
import { startJobs } from "./jobs/scheduler.js";
import { defaultFrom, logOnlyMailer, smtpMailer } from "./auth/mailer.js";
import { LiveHub } from "./live/hub.js";
import { AlertDispatcher } from "./alerts/dispatcher.js";
import { parseSecretsKey } from "./alerts/crypto.js";

const env = loadEnv();
configureLimits({ betaAllPro: env.BETA_ALL_PRO });
const { db, close } = createDb(env.DATABASE_URL);
const limiters = createLimiters({ waitlistGlobalCapPerHour: env.WAITLIST_GLOBAL_CAP_PER_HOUR });
// Free memory held by expired per-IP buckets even when no new keys arrive.
limiters.waitlistPerIp.startSweeper(60_000);

limiters.ingestPerKey.startSweeper(60_000);
limiters.ingestPerIp.startSweeper(60_000);
limiters.snapshotPerServer.startSweeper(60_000);
for (const l of Object.values(limiters.auth)) l.startSweeper(60_000);
limiters.passwordPerUser.startSweeper(60_000);
limiters.alertTestPerServer.startSweeper(60_000);
limiters.exportPerUser.startSweeper(60_000);
const mailer = env.SMTP_HOST
  ? smtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
      from: env.MAIL_FROM ?? defaultFrom(),
    })
  : logOnlyMailer(console.log);
const hub = new LiveHub({ db, now: Date.now, log: console.log });
const stopHub = hub.start();
const alerts = new AlertDispatcher({
  db,
  now: Date.now,
  webOrigin: env.WEB_PUBLIC_URL,
  secretsKey: env.SECRETS_KEY ? parseSecretsKey(env.SECRETS_KEY) : undefined,
  log: console.log,
});
const app = createApp({ db, env, limiters, mailer, hub, alerts });
const stopJobs = startJobs(
  db,
  console.log,
  { incidentHours: env.FINDING_RECHECK_INCIDENT_HOURS, serverMinutes: env.FINDING_RECHECK_SERVER_MINUTES },
  alerts,
);

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST }, (info) => {
  console.log(`api listening on ${info.address}:${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopJobs();
  stopHub();
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
