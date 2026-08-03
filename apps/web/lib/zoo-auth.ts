import { cookies } from "next/headers";

import { openCookie, sealCookie } from "@/lib/oauth";
import { readResponseText } from "@/lib/request-security";

const ZOO_API_BASE = "https://api.zoo.dev";
const SESSION_COOKIE = "quoteready_zoo_session";
const TRANSACTION_COOKIE = "quoteready_oauth_transaction";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;

interface ZooUserSummary {
  id: string;
  name: string;
  email: string;
  image: string;
}

export interface ZooSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  issuedAt: number;
  absoluteExpiresAt: number;
  user: ZooUserSummary;
}

interface OAuthTransaction {
  state: string;
  verifier: string;
  createdAt: number;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface ZooUserResponse {
  id?: unknown;
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
  image?: unknown;
}

export class ZooAuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    /** Zoo definitively rejected the credentials — the session is dead. */
    readonly invalidGrant = false,
  ) {
    super(message);
    this.name = "ZooAuthError";
  }
}

export function getOAuthConfig() {
  const clientId = process.env.ZOO_OAUTH_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.ZOO_OAUTH_REDIRECT_URI?.trim() ?? "";
  const sessionSecret = process.env.QUOTE_READY_SESSION_SECRET?.trim() ?? "";

  return {
    clientId,
    redirectUri,
    sessionSecret,
    configured: Boolean(clientId && redirectUri && sessionSecret.length >= 32),
  };
}

export function requireOAuthConfig() {
  const config = getOAuthConfig();
  if (!config.configured) {
    throw new ZooAuthError(
      "Zoo OAuth is not configured. Set ZOO_OAUTH_CLIENT_ID, ZOO_OAUTH_REDIRECT_URI and a 32+ character QUOTE_READY_SESSION_SECRET in the runtime environment.",
      503,
    );
  }
  return config;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

function parseExpiry(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Date.now() + seconds * 1000
    : undefined;
}

async function tokenRequest(
  params: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const response = await fetch(`${ZOO_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readResponseText(response, 64 * 1024);
  let payload: OAuthTokenResponse = {};

  try {
    payload = text ? (JSON.parse(text) as OAuthTokenResponse) : {};
  } catch {
    throw new ZooAuthError(
      "Zoo returned an unreadable OAuth token response.",
      502,
    );
  }

  if (!response.ok || typeof payload.access_token !== "string") {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
    // 400/401 mean Zoo rejected the grant itself; anything else (5xx, missing
    // token in a 2xx) is a transient upstream problem the caller may retry.
    const rejected = response.status === 400 || response.status === 401;
    throw new ZooAuthError(
      `Zoo OAuth token exchange failed: ${detail}`,
      rejected ? 401 : 502,
      rejected,
    );
  }

  return payload;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  verifier: string;
}): Promise<Omit<ZooSession, "user">> {
  const config = requireOAuthConfig();
  const payload = await tokenRequest(
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: config.redirectUri,
    }),
  );

  return {
    accessToken: payload.access_token as string,
    refreshToken:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : undefined,
    expiresAt: parseExpiry(payload.expires_in),
    issuedAt: Date.now(),
    absoluteExpiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
}

async function refreshAccessToken(session: ZooSession): Promise<ZooSession> {
  if (!session.refreshToken) {
    throw new ZooAuthError(
      "Your Zoo session has expired. Sign in again.",
      401,
      true,
    );
  }

  const config = requireOAuthConfig();
  const payload = await tokenRequest(
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  );

  return {
    ...session,
    accessToken: payload.access_token as string,
    refreshToken:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : session.refreshToken,
    expiresAt: parseExpiry(payload.expires_in),
  };
}

/**
 * Zoo rotates the refresh token on every use, so two requests refreshing the
 * same session in parallel would burn each other's token: the loser gets
 * "refresh token is expired or revoked" and the user is logged out. Concurrent
 * refreshes of the same token therefore share one in-flight request, and the
 * rotated result is kept for a grace window so a request that still carries
 * the pre-rotation cookie is healed instead of rejected.
 */
const ROTATION_GRACE_MS = 10 * 60 * 1000;
const refreshFlights = new Map<string, Promise<ZooSession>>();
const rotatedSessions = new Map<
  string,
  { session: ZooSession; rotatedAt: number }
>();

function pruneRotatedSessions(now: number): void {
  for (const [key, entry] of rotatedSessions) {
    if (now - entry.rotatedAt > ROTATION_GRACE_MS) rotatedSessions.delete(key);
  }
}

export async function refreshZooSessionShared(
  session: ZooSession,
  refresh: (session: ZooSession) => Promise<ZooSession> = refreshAccessToken,
): Promise<ZooSession> {
  const key = session.refreshToken;
  if (!key) return refresh(session);

  pruneRotatedSessions(Date.now());
  const rotated = rotatedSessions.get(key);
  if (rotated) return rotated.session;

  let flight = refreshFlights.get(key);
  if (!flight) {
    flight = (async () => {
      try {
        const next = await refresh(session);
        rotatedSessions.set(key, { session: next, rotatedAt: Date.now() });
        return next;
      } finally {
        refreshFlights.delete(key);
      }
    })();
    refreshFlights.set(key, flight);
  }
  return flight;
}

/** Test hook: clears the shared refresh state between test cases. */
export function resetZooRefreshCoordination(): void {
  refreshFlights.clear();
  rotatedSessions.clear();
}

export async function fetchZooUser(
  accessToken: string,
): Promise<ZooUserSummary> {
  const response = await fetch(`${ZOO_API_BASE}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readResponseText(response, 256 * 1024);
  let payload: ZooUserResponse = {};

  try {
    payload = text ? (JSON.parse(text) as ZooUserResponse) : {};
  } catch {
    throw new ZooAuthError("Zoo returned an unreadable user profile.", 502);
  }

  if (!response.ok || typeof payload.id !== "string") {
    throw new ZooAuthError(
      "QuoteReady Studio could not read the authenticated Zoo profile.",
      502,
    );
  }

  const fallbackName = [payload.first_name, payload.last_name]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ");

  return {
    id: payload.id.slice(0, 200),
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim().slice(0, 160)
        : (fallbackName || "Zoo user").slice(0, 160),
    email: typeof payload.email === "string" ? payload.email.slice(0, 320) : "",
    image:
      typeof payload.image === "string" ? payload.image.slice(0, 2_048) : "",
  };
}

export async function storeOAuthTransaction(
  transaction: OAuthTransaction,
): Promise<void> {
  const config = requireOAuthConfig();
  const store = await cookies();
  store.set(
    TRANSACTION_COOKIE,
    sealCookie(transaction, config.sessionSecret),
    cookieOptions(TRANSACTION_MAX_AGE_SECONDS),
  );
}

export async function readOAuthTransaction(): Promise<OAuthTransaction | null> {
  const config = requireOAuthConfig();
  const store = await cookies();
  return openCookie<OAuthTransaction>(
    store.get(TRANSACTION_COOKIE)?.value,
    config.sessionSecret,
  );
}

export async function clearOAuthTransaction(): Promise<void> {
  const store = await cookies();
  store.delete(TRANSACTION_COOKIE);
}

export async function storeZooSession(session: ZooSession): Promise<void> {
  const config = requireOAuthConfig();
  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    sealCookie(session, config.sessionSecret),
    cookieOptions(SESSION_MAX_AGE_SECONDS),
  );
}

export async function readZooSession(
  options: { refresh?: boolean } = {},
): Promise<ZooSession | null> {
  const config = getOAuthConfig();
  if (!config.configured) return null;

  const store = await cookies();
  let session = openCookie<ZooSession>(
    store.get(SESSION_COOKIE)?.value,
    config.sessionSecret,
  );
  if (
    !session?.accessToken ||
    !session.user?.id ||
    !Number.isFinite(session.issuedAt) ||
    !Number.isFinite(session.absoluteExpiresAt) ||
    session.issuedAt > Date.now() + 60_000 ||
    session.absoluteExpiresAt <= Date.now() ||
    session.absoluteExpiresAt - session.issuedAt >
      SESSION_MAX_AGE_SECONDS * 1000 + 60_000
  ) {
    store.delete(SESSION_COOKIE);
    return null;
  }

  if (
    options.refresh &&
    session.expiresAt &&
    session.expiresAt <= Date.now() + 60_000
  ) {
    try {
      session = await refreshZooSessionShared(session);
      await storeZooSession(session);
    } catch (error) {
      // Only a definitive rejection kills the session; a transient Zoo or
      // network failure keeps the cookie so the user stays signed in and the
      // next request can retry the refresh.
      if (error instanceof ZooAuthError && error.invalidGrant) {
        store.delete(SESSION_COOKIE);
      }
      throw error;
    }
  }

  return session;
}

export async function clearZooSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function revokeZooToken(token: string): Promise<boolean> {
  const config = requireOAuthConfig();
  try {
    const response = await fetch(`${ZOO_API_BASE}/oauth2/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, token }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
