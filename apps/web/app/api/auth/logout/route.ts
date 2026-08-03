import { NextResponse } from "next/server";

import { assertSameOrigin, inputErrorResponse } from "@/lib/request-security";
import {
  clearZooSession,
  readZooSession,
  revokeZooToken,
} from "@/lib/zoo-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await readZooSession();
    const tokens = session
      ? [
          ...new Set(
            [session.accessToken, session.refreshToken].filter(
              (token): token is string => Boolean(token),
            ),
          ),
        ]
      : [];
    const results = await Promise.all(
      tokens.map((token) => revokeZooToken(token)),
    );
    await clearZooSession();
    return NextResponse.json({
      loggedOut: true,
      revoked: results.every(Boolean),
    });
  } catch (error) {
    return inputErrorResponse(error, "The Zoo session could not be closed.");
  }
}
