import { afterEach, describe, expect, it, vi } from "vitest";

import {
  refreshZooSessionShared,
  resetZooRefreshCoordination,
  ZooAuthError,
  type ZooSession,
} from "@/lib/zoo-auth";

function session(overrides: Partial<ZooSession> = {}): ZooSession {
  return {
    accessToken: "access-old",
    refreshToken: `refresh-${Math.random().toString(36).slice(2)}`,
    expiresAt: Date.now() - 1_000,
    issuedAt: Date.now() - 60_000,
    absoluteExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    user: { id: "user-1", name: "Test", email: "test@example.com", image: "" },
    ...overrides,
  };
}

afterEach(() => {
  resetZooRefreshCoordination();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("refreshZooSessionShared", () => {
  it("shares one in-flight refresh between concurrent requests", async () => {
    const current = session();
    let calls = 0;
    const refresh = vi.fn(async (input: ZooSession) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...input, accessToken: "access-new", refreshToken: "rotated" };
    });

    const [first, second, third] = await Promise.all([
      refreshZooSessionShared(current, refresh),
      refreshZooSessionShared(current, refresh),
      refreshZooSessionShared(current, refresh),
    ]);

    expect(calls).toBe(1);
    expect(first.accessToken).toBe("access-new");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("serves a stale cookie the rotated session instead of re-refreshing", async () => {
    const current = session();
    const refresh = vi.fn(async (input: ZooSession) => ({
      ...input,
      accessToken: "access-new",
      refreshToken: "rotated",
    }));

    const refreshed = await refreshZooSessionShared(current, refresh);
    // A request that still carries the old cookie arrives after the rotation.
    const replayed = await refreshZooSessionShared(current, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replayed).toBe(refreshed);
  });

  it("propagates a failed refresh to every waiter and allows a retry", async () => {
    const current = session();
    let calls = 0;
    const refresh = vi.fn(async (input: ZooSession) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (calls === 1) throw new ZooAuthError("Zoo unavailable.", 502);
      return { ...input, accessToken: "access-new" };
    });

    const attempts = await Promise.allSettled([
      refreshZooSessionShared(current, refresh),
      refreshZooSessionShared(current, refresh),
    ]);
    expect(attempts.every((item) => item.status === "rejected")).toBe(true);

    const retried = await refreshZooSessionShared(current, refresh);
    expect(retried.accessToken).toBe("access-new");
    expect(calls).toBe(2);
  });

  it("flags a missing refresh token as an invalid grant", async () => {
    await expect(
      refreshZooSessionShared(session({ refreshToken: undefined })),
    ).rejects.toMatchObject({ name: "ZooAuthError", invalidGrant: true });
  });

  it("flags a definitive Zoo rejection as an invalid grant", async () => {
    vi.stubEnv("ZOO_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("ZOO_OAUTH_REDIRECT_URI", "https://example.com/api/callback");
    vi.stubEnv("QUOTE_READY_SESSION_SECRET", "s".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "refresh token is expired or revoked",
            }),
            { status: 400 },
          ),
      ),
    );

    await expect(refreshZooSessionShared(session())).rejects.toMatchObject({
      name: "ZooAuthError",
      invalidGrant: true,
    });
  });

  it("does not flag a transient Zoo failure as an invalid grant", async () => {
    vi.stubEnv("ZOO_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("ZOO_OAUTH_REDIRECT_URI", "https://example.com/api/callback");
    vi.stubEnv("QUOTE_READY_SESSION_SECRET", "s".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );

    await expect(refreshZooSessionShared(session())).rejects.toMatchObject({
      name: "ZooAuthError",
      invalidGrant: false,
    });
  });
});
