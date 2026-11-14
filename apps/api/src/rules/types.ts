// Phase 4 contract (frozen, owned by the lead): the boundary between the rules (rules-engineer, pure functions in
// this directory) and the engine that loads data and stores findings (backend-dev, apps/api/src/findings/).
// Rules never touch the DB, the clock or the network: everything they need is in RuleContext. That makes every
// rule testable with plain JSON fixtures (apps/api/test/fixtures/rules/).
import type {
  AgentEvent,
  Baseline,
  FindingEvidence,
  FindingScope,
  HelloPayload,
  HostSample,
  Incident,
  MetricName,
  RuleId,
  Severity,
  SnapshotPayload,
  WorstChunk,
} from "@tickdoctor/shared";

/** One point in time. Raw samples (seconds ≈ 10) carry `detail`; 1-min rollups (seconds = 60) don't. */
export interface RuleSample {
  ts: string; // ISO, end of the window (raw) or bucket start (rollup)
  seconds: number; // window length this point covers
  /** Hot metrics (raw value, or the rollup's _avg). Missing = not available on this server. */
  m: Partial<Record<MetricName, number>>;
  /** Rollups only: the _max column (e.g. peak MSPT p95 inside the minute). */
  max?: Partial<Record<MetricName, number>>;
  detail?: {
    worlds: {
      name: string;
      loadedChunks: number;
      entities: number;
      entitiesByType: Record<string, number>;
      tileEntitiesByType: Record<string, number>;
      chunkGenPerMinute?: number;
      countsAgeSeconds: number;
    }[];
    worstChunks: WorstChunk[];
    gcPauses: { collector: string; count: number; totalMs: number; maxMs: number }[];
    heapCommittedBytes: number;
    threadCount: number;
    host?: HostSample; // incl. throttled, swapTotalBytes, memTotalBytes
  };
}

/** A stored event (player ids never present). */
export type RuleEvent = AgentEvent & { ts: string };

export interface RuleContext {
  /** "Now" for the evaluation (tests pass a fixed value). */
  now: string;
  scope: FindingScope;
  server: { id: string; plan: string };
  /** Latest hello (null if the server never sent one). */
  info: HelloPayload | null;
  /** server_info_history rows, oldest first, last 30 days. */
  infoHistory: { validFrom: string; validTo: string | null; info: HelloPayload }[];
  /** plugin_inventory_history rows (every plugin+version ever seen in the last 30 days). */
  plugins: { name: string; version: string; firstSeen: string; lastSeen: string }[];
  /**
   * Analysis window. Incident scope: [startedAt − 10 min, endedAt ?? now]. Server scope: [now − 30 min, now].
   * `samples` covers exactly this window, raw when available, else 1-min rollups. Ascending by ts.
   */
  window: { from: string; to: string };
  samples: RuleSample[];
  /** Last 7 days before window.to as 1-min rollups (no detail), ascending. For correlations (player count, trends). */
  history: RuleSample[];
  /** Events from 7 days before window.from up to window.to, ascending. */
  events: RuleEvent[];
  /** Incident scope only. */
  incident?: Incident;
  snapshot?: SnapshotPayload | null;
  baseline?: Baseline | null;
}

/** What a rule returns. The engine adds id/status/lifecycle fields (see contracts/findings.ts). */
export interface RuleFinding {
  ruleId: RuleId;
  /** Stable key for "the same problem" (e.g. "world:item", "xms-ne-xmx"). Keep it free of numbers that drift. */
  dedupKey: string;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: FindingEvidence;
  suggestedFix: string;
}

export interface Rule {
  id: RuleId;
  scopes: FindingScope[];
  /** Must return [] on a healthy server. Must never throw on missing/partial data (return [] instead). */
  evaluate(ctx: RuleContext): RuleFinding[];
}
