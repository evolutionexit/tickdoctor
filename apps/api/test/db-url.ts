/** Test DB: TEST_DATABASE_URL, else the dev DATABASE_URL with the database name swapped to tickdoctor_test. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = new URL(process.env.DATABASE_URL ?? "postgres://tickdoctor:tickdoctor@localhost:5432/tickdoctor");
  base.pathname = "/tickdoctor_test";
  return base.toString();
}
