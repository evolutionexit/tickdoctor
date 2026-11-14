import { test } from "@playwright/test";
import path from "node:path";

for (const theme of ["dark", "light"]) {
  for (const p of ["/", "/pricing"]) {
    test(`screenshot ${p} ${theme}`, async ({ page }, info) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const name = `${p === "/" ? "home" : "pricing"}-${info.project.name}-${theme}.png`;
      await page.screenshot({ path: path.join(import.meta.dirname, "../screenshots", name), fullPage: true });
    });
  }
}
