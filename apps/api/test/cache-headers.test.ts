import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createdServerResponse } from "@tickdoctor/shared";
import { makeHarness, verifiedUser } from "./app-helpers.js";
import { freshIp, handle, resetStorage } from "./helpers.js";

// Pentest F-05: authenticated JSON had no Cache-Control.
afterAll(() => handle.close());
beforeAll(resetStorage);

describe("Cache-Control on /api", () => {
  const h = makeHarness();

  it("authenticated JSON is private, no-store; public status + badge keep their own public headers", async () => {
    const { client } = await verifiedUser(h);
    const created = createdServerResponse.parse(await (await client.post("/api/servers", { name: "Cache Test" })).json());
    const id = created.server.id;

    for (const path of ["/api/account", "/api/servers", `/api/servers/${id}`, `/api/servers/${id}/incidents`]) {
      const res = await client.get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
    }
    // Errors too (a cached 401/404 body is no better).
    expect((await client.get("/api/servers/00000000-0000-4000-8000-000000000000")).headers.get("cache-control")).toBe("private, no-store");
    // The export keeps its own explicit header.
    expect((await client.get("/api/account/export")).headers.get("cache-control")).toBe("no-store");

    const slug = "cache-test-page";
    const put = await client.req("PUT", `/api/servers/${id}/status-page`, {
      enabled: true, slug, title: "Cache", showPlayers: true, showIncidents: true, showHealth: true, theme: "auto", showUptime: true, hideBranding: false,
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const anon = (p: string) => h.app.request(p, { headers: { "x-forwarded-for": freshIp() } });
    expect((await anon(`/api/public/status/${slug}`)).headers.get("cache-control")).toBe("public, max-age=30");
    expect((await anon(`/badge/${slug}.svg`)).headers.get("cache-control")).toBe("public, max-age=60");
  });
});
