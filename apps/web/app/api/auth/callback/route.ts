import { NextRequest, NextResponse } from "next/server";

import { createOAuthHomeUrl } from "@/lib/oauth";
import {
  clearOAuthTransaction,
  exchangeAuthorizationCode,
  fetchZooUser,
  getOAuthConfig,
  readOAuthTransaction,
  storeZooSession,
} from "@/lib/zoo-auth";

export const runtime = "nodejs";

function homeRedirect(
  request: NextRequest,
  key: "auth" | "auth_error",
  value: string,
) {
  const destination = createOAuthHomeUrl(
    getOAuthConfig().redirectUri,
    request.url,
  );
  if (key === "auth_error") destination.pathname = "/login";
  destination.searchParams.set(key, value);
  return NextResponse.redirect(destination);
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  const errorDescription =
    request.nextUrl.searchParams.get("error_description");
  if (error) {
    await clearOAuthTransaction();
    return homeRedirect(request, "auth_error", errorDescription || error);
  }

  try {
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const transaction = await readOAuthTransaction();

    if (!code || !state || !transaction || transaction.state !== state) {
      throw new Error(
        "The Zoo sign-in response could not be verified. Please try again.",
      );
    }
    if (Date.now() - transaction.createdAt > 10 * 60 * 1000) {
      throw new Error("The Zoo sign-in request expired. Please try again.");
    }

    const tokens = await exchangeAuthorizationCode({
      code,
      verifier: transaction.verifier,
    });
    const user = await fetchZooUser(tokens.accessToken);
    await storeZooSession({ ...tokens, user });
    await clearOAuthTransaction();

    return homeRedirect(request, "auth", "success");
  } catch (callbackError) {
    await clearOAuthTransaction();
    const message =
      callbackError instanceof Error
        ? callbackError.message
        : "Zoo sign-in failed.";
    return homeRedirect(request, "auth_error", message);
  }
}
