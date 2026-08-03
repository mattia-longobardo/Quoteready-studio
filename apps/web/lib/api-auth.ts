import { NextResponse } from "next/server";

import { readZooSession, ZooAuthError, type ZooSession } from "@/lib/zoo-auth";

export async function requireSession(): Promise<ZooSession | NextResponse> {
  try {
    const session = await readZooSession({ refresh: true });
    if (!session) {
      return NextResponse.json(
        { error: "Connect your Zoo account to use this workspace." },
        { status: 401 },
      );
    }
    return session;
  } catch (error) {
    // A failed token refresh must surface as a clean 401 (the session cookie
    // has already been cleared), never as an unhandled 500.
    console.warn(
      "Zoo session refresh failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      {
        error:
          error instanceof ZooAuthError
            ? error.message
            : "Your Zoo session has expired. Sign in again.",
      },
      { status: 401 },
    );
  }
}

export function isErrorResponse(
  value: ZooSession | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}
