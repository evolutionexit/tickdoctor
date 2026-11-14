// Typed client for the same-origin app API (contract: packages/shared/src/contracts/app.ts).
// Every response is validated with the shared zod schemas. Non-GET calls send the double-submit CSRF header.
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  apiErrorBody,
  createdServerResponse,
  agentSetup,
  firstDataResponse,
  incidentListItem,
  metricsResponse,
  providersResponse,
  discordPendingResponse,
  serverDetail,
  serverListResponse,
  sessionResponse,
  verifyTokenInfo,
  sessionUser,
  incidentDetail,
  incidentListItemV6,
  findingsListResponse,
  findingDetailResponse,
  patchFindingResponse,
  alertConfig,
  alertTestResponse,
  alertDeliveriesResponse,
  type AlertConfig,
  statusPageSettings,
  type StatusPageSettings,
  type ApiErrorCode,
  type MetricName,
} from "@tickdoctor/shared";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode | "network" | "bad_response",
    message: string,
    public fields?: Record<string, string>,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const FRIENDLY: Partial<Record<ApiErrorCode | "network" | "bad_response", string>> = {
  network: "We couldn't reach the server. Check your connection and try again.",
  bad_response: "The server sent something we didn't expect. Please try again in a moment.",
  internal: "Something went wrong on our side. Please try again in a moment.",
  rate_limited: "Too many tries. Please wait a little and try again.",
  csrf_failed: "Your session check failed. Reload the page and try again.",
  unauthorized: "Please log in to continue.",
  not_found: "We couldn't find that.",
};

export function friendlyError(e: unknown, overrides: Partial<Record<string, string>> = {}): string {
  if (e instanceof ApiError) return overrides[e.code] ?? FRIENDLY[e.code] ?? e.message;
  return FRIENDLY.network!;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

let unauthorizedHandler: (() => void) | null = null;
/** The app shell registers this so any 401 sends the user to /login. */
export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

async function ensureCsrf() {
  if (readCookie(CSRF_COOKIE)) return;
  await fetch("/api/auth/session", { credentials: "same-origin" }).catch(() => undefined);
}

async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T> | null,
  body?: unknown,
  opts: { silent401?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    await ensureCsrf();
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", FRIENDLY.network!);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
  }
  if (!res.ok) {
    const parsed = apiErrorBody.safeParse(json);
    const retry = Number(res.headers.get("Retry-After"));
    if (res.status === 401 && !opts.silent401) unauthorizedHandler?.();
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error;
      throw new ApiError(res.status, code, message, fields, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    throw new ApiError(res.status, res.status >= 500 ? "internal" : "bad_response", FRIENDLY.bad_response!);
  }
  if (!schema) return undefined as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error("Unexpected API response", path, parsed.error.issues);
    throw new ApiError(res.status, "bad_response", FRIENDLY.bad_response!);
  }
  return parsed.data;
}

const ok = z.object({ ok: z.literal(true) });
const userOnly = z.object({ user: sessionUser });
const batch = z.object({ series: z.array(metricsResponse) });
const incidents = z.object({ incidents: z.array(incidentListItem) });
const incidentsV6 = z.object({ incidents: z.array(incidentListItemV6) });

export type PutAlertConfig = Omit<AlertConfig, "webhookUrlMasked" | "webhookStatus"> & { webhookUrl?: string | null };

export const api = {
  // auth
  session: () => request("GET", "/api/auth/session", sessionResponse, undefined, { silent401: true }),
  providers: () => request("GET", "/api/auth/providers", providersResponse),
  signup: (b: { email: string; next?: string }) => request("POST", "/api/auth/signup", ok, b),
  login: (b: { email: string; password: string; next?: string }) => request("POST", "/api/auth/login", sessionResponse, b, { silent401: true }),
  logout: () => request("POST", "/api/auth/logout", ok, {}),
  logoutAll: () => request("POST", "/api/auth/logout-all", ok, {}),
  magicLink: (b: { email: string; next?: string }) => request("POST", "/api/auth/magic-link", ok, b),
  resendVerification: (email: string) => request("POST", "/api/auth/resend-verification", ok, { email }),
  verifyToken: (token: string) => request("GET", `/api/auth/verify-token?token=${encodeURIComponent(token)}`, verifyTokenInfo),
  verify: (token: string, extra?: { password: string; consent: true; displayName?: string }) => request("POST", "/api/auth/verify", sessionResponse, extra ? { token, ...extra } : { token }),
  discordPending: () => request("GET", "/api/auth/discord/pending", discordPendingResponse, undefined, { silent401: true }),
  discordComplete: (b: { consent: true; displayName?: string }) => request("POST", "/api/auth/discord/complete", sessionResponse, b),
  forgotPassword: (email: string) => request("POST", "/api/auth/forgot-password", ok, { email }),
  resetPassword: (token: string, password: string) => request("POST", "/api/auth/reset-password", sessionResponse, { token, password }),
  // servers
  servers: () => request("GET", "/api/servers", serverListResponse),
  createServer: (name: string) => request("POST", "/api/servers", createdServerResponse, { name }),
  server: (id: string) => request("GET", `/api/servers/${id}`, serverDetail),
  renameServer: (id: string, name: string) => request("PATCH", `/api/servers/${id}`, serverDetail, { name }),
  deleteServer: (id: string, confirmName: string) => request("DELETE", `/api/servers/${id}`, ok, { confirmName }),
  rotateKey: (id: string) => request("POST", `/api/servers/${id}/rotate-key`, agentSetup, {}),
  firstData: (id: string) => request("GET", `/api/servers/${id}/first-data`, firstDataResponse),
  metricsBatch: async (id: string, metrics: MetricName[], from: Date, to: Date) =>
    (await request("GET", `/api/servers/${id}/metrics/batch?metrics=${metrics.join(",")}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, batch)).series,
  incidents: async (id: string, from: Date, to: Date) =>
    (await request("GET", `/api/servers/${id}/incidents?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=200`, incidents)).incidents,
  // phase 6: incidents, findings, alerts
  incidentList: async (id: string, status?: "open" | "closed") =>
    (await request("GET", `/api/servers/${id}/incidents?limit=200${status ? `&status=${status}` : ""}`, incidentsV6)).incidents,
  incidentDetail: (incidentId: string) => request("GET", `/api/incidents/${incidentId}`, incidentDetail),
  findings: (id: string, q: { status: string; severity?: string; ruleId?: string }) => {
    const p = new URLSearchParams({ status: q.status });
    if (q.severity) p.set("severity", q.severity);
    if (q.ruleId) p.set("ruleId", q.ruleId);
    return request("GET", `/api/servers/${id}/findings?${p}`, findingsListResponse);
  },
  finding: (findingId: string) => request("GET", `/api/findings/${findingId}`, findingDetailResponse),
  setFindingStatus: async (findingId: string, status: "marked_fixed" | "open") =>
    (await request("PATCH", `/api/findings/${findingId}`, patchFindingResponse, { status })).finding,
  alerts: (id: string) => request("GET", `/api/servers/${id}/alerts`, alertConfig),
  saveAlerts: (id: string, b: PutAlertConfig) => request("PUT", `/api/servers/${id}/alerts`, alertConfig, b),
  testAlert: (id: string) => request("POST", `/api/servers/${id}/alerts/test`, alertTestResponse, {}),
  alertDeliveries: async (id: string) => (await request("GET", `/api/servers/${id}/alerts/deliveries?limit=50`, alertDeliveriesResponse)).deliveries,
  // phase 7: status page
  statusPage: (id: string) => request("GET", `/api/servers/${id}/status-page`, statusPageSettings),
  saveStatusPage: (id: string, b: Omit<StatusPageSettings, "publicUrl" | "badgeUrl">) => request("PUT", `/api/servers/${id}/status-page`, statusPageSettings, b),
  // account
  account: () => request("GET", "/api/account", userOnly),
  updateAccount: (displayName: string | null) => request("PATCH", "/api/account", userOnly, { displayName }),
  changePassword: (b: { currentPassword?: string; newPassword: string }) => request("POST", "/api/account/password", ok, b),
  // phase 8: erasure (immediate, final)
  deleteAccount: (b: { confirmEmail: string; password?: string }) => request("DELETE", "/api/account", ok, b),
};

/** GET /api/account/export → saves the JSON file the API streams. Errors become ApiError (429 → rate_limited with retryAfter). */
export async function downloadAccountExport(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/account/export", { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "network", FRIENDLY.network!);
  }
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After"));
    if (res.status === 401) unauthorizedHandler?.();
    throw new ApiError(res.status, res.status === 429 ? "rate_limited" : res.status === 401 ? "unauthorized" : "internal", res.status === 429 ? FRIENDLY.rate_limited! : FRIENDLY.internal!, undefined, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiError(0, "network", FRIENDLY.network!);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `tickdoctor-export-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Same-site relative path only; anything else becomes the fallback. Mirrors `nextPath` in the contract. */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || next.length > 500) return fallback;
  return /^\/(?!\/)[^\s\\]*$/.test(next) ? next : fallback;
}
