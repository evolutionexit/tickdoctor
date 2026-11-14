// Demo data seeder (contracts §5.5). Usage: pnpm seed [--reset | --wipe] [--days N] [--raw-hours N] [--force]
// The logic (and the list of lag episodes with their timestamps) lives in apps/api/src/seed.ts so
// it shares the API's db client, schema and rollup job. Reads DATABASE_URL (falls back to ../.env).
import { existsSync } from "node:fs";
import path from "node:path";
import { createDb } from "../apps/api/src/db/client.js";
import { assertSeedAllowed, parseSeedArgs, seed, wipeDemo } from "../apps/api/src/seed.js";

const envFile = path.resolve(__dirname, "../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

async function main() {
  const args = parseSeedArgs(process.argv.slice(2));
  try {
    assertSeedAllowed(process.env.NODE_ENV, args.force);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  // createDb pins the session TimeZone to UTC, like the API (all bucketing is UTC).
  const { db, close } = createDb(url, { max: 2 });
  try {
    if (args.reset || args.wipe) {
      await wipeDemo(db);
      console.log("demo data wiped");
    }
    if (!args.wipe) {
      const started = Date.now();
      await seed(db, { days: args.days, rawHours: args.rawHours, log: (l) => console.log(l) });
      console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  } catch (err) {
    console.error("seed failed:", err);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
