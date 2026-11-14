// Discord OAuth2 (authorization code). Only the Discord user id is kept; tokens are used once and dropped.

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Override for tests (mock server). Default https://discord.com */
  baseUrl?: string;
}

export interface DiscordProfile {
  id: string;
  email: string | null;
  verified: boolean;
  displayName: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function discordAuthorizeUrl(cfg: DiscordConfig, state: string): string {
  const u = new URL("/oauth2/authorize", cfg.baseUrl ?? "https://discord.com");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("scope", "identify email");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Exchanges the code and reads /users/@me. Throws on any failure (the caller redirects to discord_failed). */
export async function fetchDiscordProfile(cfg: DiscordConfig, code: string, fetchFn: FetchLike = fetch): Promise<DiscordProfile> {
  const base = cfg.baseUrl ?? "https://discord.com";
  const tokenRes = await fetchFn(`${base}/api/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new Error(`discord token exchange failed: ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token?: unknown; token_type?: unknown };
  if (typeof token.access_token !== "string" || token.access_token.length === 0) throw new Error("discord: no access token");

  const meRes = await fetchFn(`${base}/api/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!meRes.ok) throw new Error(`discord /users/@me failed: ${meRes.status}`);
  const me = (await meRes.json()) as Record<string, unknown>;
  if (typeof me.id !== "string" || !/^\d{1,30}$/.test(me.id)) throw new Error("discord: bad user id");
  const email = typeof me.email === "string" && me.email.length <= 254 ? me.email.trim().toLowerCase() : null;
  const name = typeof me.global_name === "string" ? me.global_name : typeof me.username === "string" ? me.username : null;
  return {
    id: me.id,
    email,
    verified: me.verified === true,
    displayName: name ? name.trim().slice(0, 60) || null : null,
  };
}
