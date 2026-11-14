import type { Finding } from "@tickdoctor/shared";

// Static example shown on the landing page (copy: content/landing.md §4). Not real data.
export const exampleFinding: Finding = {
  id: "example",
  serverId: "example",
  ruleId: "entity-explosion",
  scope: "incident",
  dedupKey: "world:item",
  severity: "high",
  title: "Item entities are piling up in one chunk",
  explanation:
    "Something is dropping items faster than they are picked up or removed, and they all sit in one place. Every one of those items is checked every tick, so the server spends much of its time on them. This is a common cause of sudden lag on survival servers, often from an item farm or a broken collection system.",
  evidence: {
    numbers: [
      { label: "Item entities in chunk (75, -25)", value: "2,340", baseline: "12" },
      { label: "Tick time, 95th percentile", value: 87, unit: "ms", baseline: "18 ms" },
      { label: "Time spent on entities", value: "61%", baseline: "14%" },
    ],
    chunks: [{ world: "world", x: 75, z: -25 }],
  },
  suggestedFix: [
    "1. Go and look: `/tp @s 1204 70 -388`",
    "2. Find what is producing the items (a farm with a full or missing collection chest is the usual suspect) and fix or switch it off.",
    "3. Clear the pile with `/kill @e[type=item,x=1204,y=70,z=-388,distance=..32]`.",
    "4. To prevent a repeat, add a timed item cleanup or lower the item despawn rate in your Paper config.",
  ].join("\n"),
  status: "open",
  incidentIds: [],
  occurrenceCount: 1,
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  markedFixedAt: null,
  confirmedFixedAt: null,
  resolvedBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const exampleTp = { world: "world", x: 1204, y: 70, z: -388 };
export const exampleSparkline = [18, 20, 19, 24, 31, 48, 87, 74, 52, 61, 38, 24, 19];
