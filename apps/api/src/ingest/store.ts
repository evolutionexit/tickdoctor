export const INGEST_ENDPOINTS = ["hello", "metrics", "events", "snapshot"] as const;
export type IngestEndpoint = (typeof INGEST_ENDPOINTS)[number];

export interface StoredPayload {
  receivedAt: string;
  keyId: string;
  body: unknown;
}

/**
 * Dev-only (INGEST_DEBUG) in-memory ring: the last `perEndpoint` accepted payloads per server and
 * endpoint, so /v1/debug/last only ever shows the caller's own server. At most `maxServers`
 * servers are tracked (least recently written evicted first).
 */
export class IngestRing {
  private readonly servers = new Map<string, Map<IngestEndpoint, StoredPayload[]>>();

  constructor(
    private readonly perEndpoint = 20,
    private readonly maxServers = 100,
  ) {}

  add(serverId: string, endpoint: IngestEndpoint, item: StoredPayload): void {
    let rings = this.servers.get(serverId);
    if (rings) this.servers.delete(serverId);
    else rings = new Map();
    this.servers.set(serverId, rings); // re-insert = most recent
    if (this.servers.size > this.maxServers) this.servers.delete(this.servers.keys().next().value!);
    let ring = rings.get(endpoint);
    if (!ring) rings.set(endpoint, (ring = []));
    ring.push(item);
    if (ring.length > this.perEndpoint) ring.splice(0, ring.length - this.perEndpoint);
  }

  /** Oldest first. */
  list(serverId: string, endpoint: IngestEndpoint): StoredPayload[] {
    return [...(this.servers.get(serverId)?.get(endpoint) ?? [])];
  }
}
