import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

/** Folder with drizzle-kit migrations. Works from src/db (tsx) and dist (bundled). */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Empty counts as unset (.env.example lists MIGRATIONS_DIR= empty).
  return process.env.MIGRATIONS_DIR || path.resolve(here, path.basename(here) === "db" ? "../../drizzle" : "../drizzle");
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("migrations applied"))
    .catch((err) => {
      console.error("migration failed:", err);
      process.exit(1);
    });
}
