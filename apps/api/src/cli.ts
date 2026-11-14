import { parseArgs } from "node:util";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { findingStatus } from "@tickdoctor/shared";
import { createDb, type Db } from "./db/client.js";
import { buildContext } from "./findings/context.js";
import { backfillAndEvaluate, evaluateIncident, evaluateServer } from "./findings/engine.js";
import { formatFinding, formatIncident, formatIncidentLine } from "./findings/format.js";
import { getFinding, listFindings, listFindingsForIncident, markFixed } from "./findings/lifecycle.js";
import { getIncident, listIncidents } from "./incidents/store.js";
import { requestSnapshot } from "./ingest/storage.js";
import { parseBetaAllPro, parsePepper } from "./env.js";
import { configureLimits } from "./limits.js";
import { AlertDispatcher } from "./alerts/dispatcher.js";
import { parseSecretsKey } from "./alerts/crypto.js";
import type { FetchLike, Sleep } from "./alerts/webhook.js";
import { exportDemo, writeDemoDataset } from "./demo/export.js";
import { deleteAccount, findUserIdByEmail } from "./account/delete.js";
import { defaultFrom, logOnlyMailer, mails, smtpMailer, type Mailer } from "./auth/mailer.js";
import { createServer, listServers, revokeKeys, rotateKey, setUserPlan, transferServer } from "./servers.js";

// pnpm --filter @tickdoctor/api cli <command>
//   server:create --name "<name>" --owner-email <email> [--plan free|pro|network]
//   server:rotate-key <serverId>
//   server:revoke-key <serverId>      (revokes every active key, issues none: the server is cut off)
//   server:list
//   server:request-snapshot <serverId>
//   server:transfer <serverId> --owner-email <email> [--keep-key]
//                     (moves the server and all its data to an existing user; rotates the agent key unless
//                      --keep-key; ignores the new owner's plan server limit)
//   user:set-plan <email> <free|pro|network>            (also sets the plan of every server they own)
//   user:delete <email> --yes        (support: same erasure as DELETE /api/account, incl. waitlist + Discord rows;
//                                     sends the "account deleted" email when SMTP_HOST is set; live streams close
//                                     within the API's 15 s owner check)
//   incident:list <serverId> · incident:show <incidentId> · incidents:backfill <serverId> [--from <iso>] [--to <iso>]
//   finding:list <serverId> [--status open|marked_fixed|confirmed_fixed] · finding:show <findingId> · finding:mark-fixed <findingId>
//   alerts:test <serverId>          (sends a Discord test alert; prints the result, never the webhook URL)
//   demo:export <serverId> --name "<made-up name>" [--out <path>] [--source pi-test-history|seed]
//                     (writes the cleaned demo dataset, default <repo>/apps/web/content/demo/dataset.json)
//   rules:run <serverId> [--incident <id>] · rules:context <serverId> --scope server|incident [--incident <id>] [--at <iso>]
// Keys are printed exactly once, to stdout, and never logged anywhere else.

const USAGE = `usage:
  cli server:create --name "<name>" --owner-email <email> [--plan free|pro|network]
  cli server:rotate-key <serverId>
  cli server:revoke-key <serverId>
  cli server:list
  cli server:request-snapshot <serverId>
  cli server:transfer <serverId> --owner-email <email> [--keep-key]   (rotates the key unless --keep-key; no plan-limit check)
  cli user:set-plan <email> <free|pro|network>
  cli user:delete <email> --yes   (immediate and final: the account, its servers and all their data)
  cli incident:list <serverId>
  cli incident:show <incidentId>
  cli incidents:backfill <serverId> [--from <iso>] [--to <iso>]
  cli finding:list <serverId> [--status open|marked_fixed|confirmed_fixed]
  cli finding:show <findingId>
  cli finding:mark-fixed <findingId>
  cli rules:run <serverId> [--incident <incidentId>]   (re-run incident rules for one incident)
  cli rules:context <serverId> --scope server|incident [--incident <incidentId>] [--at <iso>]
  cli alerts:test <serverId>   (needs SECRETS_KEY and WEB_PUBLIC_URL like the API)
  cli demo:export <serverId> --name "<made-up name>" [--out <path>] [--source pi-test-history|seed]`;

const uuid = z.string().uuid();

function isoArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`${name} must be an ISO timestamp`);
  return t;
}

async function assertServer(db: Db, id: string) {
  const r = await db.execute(sql`select 1 from servers where id = ${id}`);
  if (r.length === 0) throw new Error("server not found");
}

/** Same validation as the API's env schema (env.ts), so the CLI can't mint keys the API would reject. */
const needPepper = (): string => parsePepper(process.env);

export interface CliDeps {
  /** Tests inject a mock Discord. */
  fetch?: FetchLike;
  sleep?: Sleep;
  /** user:delete confirmation email (default: SMTP from env, else log-only). */
  mailer?: Mailer;
}

function mailerFromEnv(env: Record<string, string | undefined>, log: (l: string) => void): Mailer {
  if (!env.SMTP_HOST) return logOnlyMailer(log);
  return smtpMailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 1025,
    user: env.SMTP_USER || undefined,
    password: env.SMTP_PASSWORD || undefined,
    secure: env.SMTP_SECURE === "true" || env.SMTP_SECURE === "1",
    from: env.MAIL_FROM || defaultFrom(),
  });
}

interface CmdCtx {
  db: Db;
  rest: string[];
  out: (l: string) => void;
  deps: CliDeps;
}

async function runServerCreate({ db, rest, out }: CmdCtx): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { name: { type: "string" }, "owner-email": { type: "string" }, plan: { type: "string" } },
  });
  if (!values.name || !values["owner-email"]) throw new Error(USAGE);
  const s = await createServer(db, needPepper(), { name: values.name, ownerEmail: values["owner-email"], plan: values.plan });
  out(`server_id=${s.serverId}`);
  out(`slug=${s.slug}`);
  out(`api_key=${s.key}`);
  out("The API key is shown only once. Put it in the plugin's config.yml (api-key).");
  return 0;
}

async function runServerRotateKey({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  const r = await rotateKey(db, needPepper(), id.data);
  if (!r) throw new Error("server not found");
  out(`revoked_keys=${r.revoked}`);
  out(`api_key=${r.key}`);
  out("The API key is shown only once. The old key stops working immediately.");
  return 0;
}

async function runServerRevokeKey({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  const r = await revokeKeys(db, id.data);
  if (!r) throw new Error("server not found");
  out(`revoked_keys=${r.revoked}`);
  out("No new key was issued; the server's agent can't send data until you run server:rotate-key.");
  return 0;
}

async function runServerList({ db, out }: CmdCtx): Promise<number> {
  const rows = await listServers(db);
  if (rows.length === 0) out("(no servers)");
  for (const r of rows) {
    out(
      [r.id, r.slug, r.plan, r.ownerEmail, r.activeKeyPrefix ? `${r.activeKeyPrefix}…` : "(no key)", r.lastSeenAt?.toISOString() ?? "never", JSON.stringify(r.name)].join("\t"),
    );
  }
  return 0;
}

async function runServerRequestSnapshot({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  if (!(await requestSnapshot(db, id.data))) throw new Error("server not found");
  out("snapshot requested; sent with the server's next metrics response");
  return 0;
}

async function runServerTransfer({ db, rest, out }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { "owner-email": { type: "string" }, "keep-key": { type: "boolean" } },
  });
  const id = uuid.safeParse(positionals[0]);
  if (!id.success || !values["owner-email"]) throw new Error(USAGE);
  const r = await transferServer(db, id.data, values["owner-email"]);
  if (r === "no_server") throw new Error("server not found");
  if (r === "no_user") throw new Error("no user with that email (they must sign up first)");
  out(`server_id=${id.data}`);
  out(`owner_id=${r.ownerId}`);
  out(`plan=${r.plan}`);
  out("Note: the new owner's plan server limit is not checked (admin override).");
  if (values["keep-key"]) {
    out("The agent key was kept (--keep-key): whoever held it before can still send data for this server.");
  } else {
    // The previous owner knows the old key: rotate so they can't keep writing into the new owner's server.
    const k = await rotateKey(db, needPepper(), id.data);
    if (!k) throw new Error("server not found");
    out(`revoked_keys=${k.revoked}`);
    out(`api_key=${k.key}`);
    out("The new API key is shown only once. Put it in the plugin's config.yml (api-key); the old key stopped working.");
  }
  return 0;
}

async function runUserSetPlan({ db, rest, out }: CmdCtx): Promise<number> {
  const [email, plan] = rest;
  if (!email || !plan || rest.length !== 2) throw new Error(USAGE);
  const r = await setUserPlan(db, email, plan);
  if (!r) throw new Error("user not found");
  out(`plan=${plan}`);
  out(`servers_updated=${r.servers}`);
  return 0;
}

async function runUserDelete({ db, rest, out, deps }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({ args: rest, options: { yes: { type: "boolean" } }, allowPositionals: true });
  const [email] = positionals;
  if (!email || positionals.length !== 1) throw new Error(USAGE);
  if (!values.yes) throw new Error("refusing without --yes: deletion is immediate and final");
  const id = await findUserIdByEmail(db, email);
  if (!id) throw new Error("user not found");
  const r = await deleteAccount(db, id);
  if (!r) throw new Error("user not found");
  out("deleted=1");
  out(`servers_deleted=${r.serverIds.length}`);
  const mailer = deps.mailer ?? mailerFromEnv(process.env, out);
  try {
    await mailer.send(mails.accountDeleted(r.email));
    out("mail=sent");
  } catch (err) {
    out(`mail=failed (${err instanceof Error ? err.message : String(err)})`);
  }
  return 0;
}

async function runIncidentList({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  const list = await listIncidents(db, id.data);
  if (list.length === 0) out("(no incidents)");
  for (const i of list) out(formatIncidentLine(i, (await listFindingsForIncident(db, i.id)).length));
  return 0;
}

async function runIncidentShow({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  const inc = await getIncident(db, id.data);
  if (!inc) throw new Error("incident not found");
  for (const l of formatIncident(inc, await listFindingsForIncident(db, inc.id))) out(l);
  return 0;
}

async function runIncidentsBackfill({ db, rest, out }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { from: { type: "string" }, to: { type: "string" } } });
  const id = uuid.safeParse(positionals[0]);
  if (!id.success) throw new Error(USAGE);
  await assertServer(db, id.data);
  const r = await backfillAndEvaluate(db, id.data, { from: isoArg(values.from, "--from"), to: isoArg(values.to, "--to"), log: out });
  out(`created=${r.created.length} skipped_overlap=${r.skippedOverlap}${r.ongoing ? " ongoing=1" : ""}`);
  return 0;
}

async function runFindingList({ db, rest, out }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { status: { type: "string" } } });
  const id = uuid.safeParse(positionals[0]);
  const status = values.status === undefined ? undefined : findingStatus.safeParse(values.status);
  if (!id.success || (status && !status.success)) throw new Error(USAGE);
  const list = await listFindings(db, id.data, status?.data);
  if (list.length === 0) out("(no findings)");
  for (const f of list) out([f.id, f.status, f.severity, f.ruleId, f.scope, `${f.occurrenceCount}x`, f.lastSeenAt, JSON.stringify(f.title)].join("\t"));
  return 0;
}

async function runFindingShow({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  const f = await getFinding(db, id.data);
  if (!f) throw new Error("finding not found");
  for (const l of formatFinding(f)) out(l);
  return 0;
}

async function runFindingMarkFixed({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  if (!(await markFixed(db, id.data))) throw new Error("finding not found or not open");
  out("marked fixed; it is confirmed once the problem stays away for the recheck window (with fresh data)");
  return 0;
}

async function runRulesRun({ db, rest, out }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  await assertServer(db, id.data);
  const incFlag = rest.indexOf("--incident");
  let r;
  if (incFlag >= 0) {
    const inc = uuid.safeParse(rest[incFlag + 1]);
    if (!inc.success) throw new Error(USAGE);
    const incident = await getIncident(db, inc.data);
    if (!incident || incident.serverId !== id.data) throw new Error("incident not found for this server");
    r = await evaluateIncident(db, inc.data, { log: out });
  } else {
    r = await evaluateServer(db, id.data, { log: out });
  }
  out(`findings=${r.findings.length} created=${r.findings.filter((f) => f.created).length} reopened=${r.findings.filter((f) => f.reopened).length}`);
  for (const f of r.findings) out(`  ${f.id} ${f.ruleId} ${f.dedupKey}${f.created ? " (new)" : ""}`);
  return 0;
}

async function runRulesContext({ db, rest, out }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { scope: { type: "string" }, incident: { type: "string" }, at: { type: "string" } },
  });
  const id = uuid.safeParse(positionals[0]);
  const scope = values.scope === "server" || values.scope === "incident" ? values.scope : null;
  if (!id.success || !scope) throw new Error(USAGE);
  let incidentId: string | undefined;
  if (scope === "incident") {
    const inc = uuid.safeParse(values.incident);
    if (!inc.success) throw new Error("--incident <incidentId> is required for --scope incident");
    incidentId = inc.data;
  }
  const ctx = await buildContext(db, { serverId: id.data, scope, incidentId, nowMs: isoArg(values.at, "--at") ?? Date.now() });
  out(JSON.stringify(ctx, null, 2));
  return 0;
}

async function runAlertsTest({ db, rest, out, deps }: CmdCtx): Promise<number> {
  const id = uuid.safeParse(rest[0]);
  if (!id.success) throw new Error(USAGE);
  await assertServer(db, id.data);
  const key = process.env.SECRETS_KEY ? parseSecretsKey(process.env.SECRETS_KEY) : undefined;
  const alerts = new AlertDispatcher({
    db,
    now: Date.now,
    webOrigin: process.env.WEB_PUBLIC_URL ? new URL(process.env.WEB_PUBLIC_URL).origin : "http://localhost:3000",
    secretsKey: key,
    fetch: deps.fetch,
    sleep: deps.sleep,
  });
  const r = await alerts.sendTest(id.data);
  if (r === "no_webhook") throw new Error("no Discord webhook saved for this server (Alerts tab)");
  if (!r.ok) {
    out(`test alert failed${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}: ${r.error ?? "unknown error"}`);
    return 1;
  }
  out(`test alert sent (HTTP ${r.httpStatus})`);
  return 0;
}

async function runDemoExport({ db, rest, out }: CmdCtx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { name: { type: "string" }, out: { type: "string" }, source: { type: "string" } },
  });
  const id = uuid.safeParse(positionals[0]);
  const name = values.name?.trim();
  if (!id.success || !name || name.length > 60) throw new Error(USAGE);
  if (values.source !== undefined && values.source !== "pi-test-history" && values.source !== "seed") throw new Error(USAGE);
  const data = await exportDemo(db, id.data, { name, source: values.source });
  const { path, bytes } = await writeDemoDataset(data, values.out);
  out(`wrote ${path}`);
  out(`bytes=${bytes}`);
  out(`incidents=${data.incidents.length} findings=${data.findings.length} metrics=${Object.keys(data.series.metrics).length}`);
  return 0;
}

const COMMANDS = new Map<string, (c: CmdCtx) => Promise<number>>([
  ["server:create", runServerCreate],
  ["server:rotate-key", runServerRotateKey],
  ["server:revoke-key", runServerRevokeKey],
  ["server:list", runServerList],
  ["server:request-snapshot", runServerRequestSnapshot],
  ["server:transfer", runServerTransfer],
  ["user:set-plan", runUserSetPlan],
  ["user:delete", runUserDelete],
  ["incident:list", runIncidentList],
  ["incident:show", runIncidentShow],
  ["incidents:backfill", runIncidentsBackfill],
  ["finding:list", runFindingList],
  ["finding:show", runFindingShow],
  ["finding:mark-fixed", runFindingMarkFixed],
  ["rules:run", runRulesRun],
  ["rules:context", runRulesContext],
  ["alerts:test", runAlertsTest],
  ["demo:export", runDemoExport],
]);

export async function main(argv: string[], out: (l: string) => void = console.log, deps: CliDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  configureLimits({ betaAllPro: parseBetaAllPro(process.env) });
  const { db, close } = createDb(url, { max: 2 });
  try {
    const run = cmd === undefined ? undefined : COMMANDS.get(cmd);
    if (!run) throw new Error(USAGE);
    return await run({ db, rest, out, deps });
  } finally {
    await close();
  }
}

const isMain = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  // No process.exit(): it would cut off stdout that is still draining into a pipe (big rules:context output was
  // truncated at 128 KiB multiples). Set the exit code and let the event loop end once everything is written.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
