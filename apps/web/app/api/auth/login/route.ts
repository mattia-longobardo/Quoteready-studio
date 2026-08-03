import { NextRequest, NextResponse } from "next/server";

import {
  createOAuthHomeUrl,
  createOAuthState,
  createPkcePair,
  ZOO_OAUTH_SCOPE,
} from "@/lib/oauth";
import {
  getOAuthConfig,
  requireOAuthConfig,
  storeOAuthTransaction,
  ZooAuthError,
} from "@/lib/zoo-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = requireOAuthConfig();
    const state = createOAuthState();
    const { verifier, challenge } = createPkcePair();
    await storeOAuthTransaction({ state, verifier, createdAt: Date.now() });

    const authorizeUrl = new URL("https://api.zoo.dev/oauth2/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: ZOO_OAUTH_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zoo OAuth could not start.";
    const status = error instanceof ZooAuthError ? error.status : 500;
    if (request.nextUrl.searchParams.get("format") === "json") {
      return NextResponse.json({ error: message }, { status });
    }
    const destination = createOAuthHomeUrl(
      getOAuthConfig().redirectUri,
      request.url,
    );
    destination.pathname = "/login";
    destination.searchParams.set("auth_error", message);
    return NextResponse.redirect(destination);
  }
}
