import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: /phase7-ratelimit/, grepInvert: /@free/, teardown: "ratelimit", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile", testIgnore: /phase7-ratelimit/, grepInvert: /@free/, use: { ...devices["Pixel 7"] } },
    // Free-plan limits: only meaningful with BETA_ALL_PRO=false on the API; run through ./run-all.sh (or ./run-free.sh)
    { name: "freeplan", grep: /@free/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // exhausts the per-IP public-status limit; runs as desktop's teardown (after all desktop specs, even if some failed)
    { name: "ratelimit", testMatch: /phase7-ratelimit/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
});
