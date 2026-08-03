import { describe, expect, it } from "vitest";

import {
  createOAuthHomeUrl,
  createOAuthState,
  createPkcePair,
  openCookie,
  sealCookie,
  ZOO_OAUTH_SCOPE,
} from "@/lib/oauth";

describe("OAuth helpers", () => {
  it("redirects back to the configured public origin behind a reverse proxy", () => {
    const destination = createOAuthHomeUrl(
      "https://quoteready.longobardo.me/api/auth/callback",
      "https://0.0.0.0:3000/api/auth/callback",
    );

    expect(destination.toString()).toBe("https://quoteready.longobardo.me/");
  });

  it("requests the least-privilege scopes required by QuoteReady Studio", () => {
    expect(ZOO_OAUTH_SCOPE.split(" ")).toEqual(["user:read", "modeling"]);
  });

  it("creates an S256-compatible PKCE pair", () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(createOAuthState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips an encrypted session cookie", () => {
    const secret = "a-test-secret-that-is-at-least-thirty-two-characters";
    const value = { accessToken: "zoo-token", user: { id: "123" } };
    const sealed = sealCookie(value, secret);
    expect(sealed).not.toContain("zoo-token");
    expect(openCookie(sealed, secret)).toEqual(value);
  });

  it("rejects a tampered cookie", () => {
    const secret = "a-test-secret-that-is-at-least-thirty-two-characters";
    const sealed = sealCookie({ accessToken: "zoo-token" }, secret);
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("a") ? "b" : "a"}`;
    expect(openCookie(tampered, secret)).toBeNull();
  });
});
