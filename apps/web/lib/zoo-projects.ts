import { getSettings } from "@/lib/platform-store";
import { readResponseText } from "@/lib/request-security";
import { getUserZooApiToken } from "@/lib/user-settings";
import type { ZooSession } from "@/lib/zoo-auth";

const ZOO_API_BASE = "https://api.zoo.dev";
const OWNER_CACHE_MS = 10 * 60_000;
const OWNER_CACHE_MAX = 200;

const ownerCache = new Map<string, { userId: string; fetchedAt: number }>();

interface ProjectsToken {
  token: string;
  source: "api-token" | "oauth";
}

async function tokenOwner(token: string): Promise<string | null> {
  const cached = ownerCache.get(token);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < OWNER_CACHE_MS) return cached.userId;
  try {
    const response = await fetch(`${ZOO_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await readResponseText(response, 256 * 1024);
    if (!response.ok) {
      console.warn(
        `Zoo API token verification failed: HTTP ${response.status}`,
      );
      return null;
    }
    const payload = JSON.parse(text) as { id?: unknown };
    if (typeof payload.id !== "string") return null;
    if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear();
    ownerCache.set(token, { userId: payload.id, fetchedAt: now });
    return payload.id;
  } catch (error) {
    console.warn(
      "Zoo API token verification failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Zoo's Projects API only defines the OAuth scopes user:read, modeling and
 * admin:write — there is no projects scope, so third-party OAuth tokens get
 * 403. Each user therefore stores a personal Zoo API token in their
 * settings; it is used only after verifying (with a short cache) that it
 * belongs to the signed-in Zoo account. There is deliberately no
 * deployment-wide env fallback: the token always comes from user settings.
 */
export async function resolveProjectsToken(
  session: ZooSession,
): Promise<ProjectsToken> {
  const settings = await getSettings(session.user.id).catch(() => null);
  const token = getUserZooApiToken(settings);
  if (token && (await tokenOwner(token)) === session.user.id) {
    return { token, source: "api-token" };
  }
  return { token: session.accessToken, source: "oauth" };
}

/** Human-readable explanation for a 403 from the Zoo Projects API. */
export function projectsForbiddenDetail(
  source: ProjectsToken["source"],
): string {
  return source === "oauth"
    ? "Zoo's Projects API does not accept third-party OAuth tokens. Add your personal Zoo API token in Settings to enable the library."
    : "The configured Zoo API token was rejected by Zoo. Check in Settings that the token is valid and belongs to the signed-in account.";
}
