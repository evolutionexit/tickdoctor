import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../..");

export const PAGES = ["/", "/pricing", "/legal/privacy", "/legal/terms", "/legal/mentions-legales"];

/** Collects console errors and CSP violations; call before page.goto. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return errors;
}

export async function expectNoHScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(r.sw, `scrollWidth ${r.sw} > innerWidth ${r.iw}`).toBeLessThanOrEqual(r.iw);
}

export function psqlCount(email: string): number {
  const out = execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "tickdoctor", "-tAc", `select count(*) from waitlist where email='${email}'`],
    { cwd: repoRoot, env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` } },
  );
  return Number(out.toString().trim());
}

export function restartApi() {
  const env = { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` };
  execFileSync("docker", ["compose", "restart", "api"], { cwd: repoRoot, env });
}

export async function waitApiHealthy(baseURL: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${baseURL}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("API not healthy");
}
