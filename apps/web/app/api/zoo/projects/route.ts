import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { readResponseText, RequestInputError } from "@/lib/request-security";
import {
  projectsForbiddenDetail,
  resolveProjectsToken,
} from "@/lib/zoo-projects";

export const runtime = "nodejs";

const MAX_PROJECT_RESPONSE_BYTES = 512 * 1024;

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    const { token, source } = await resolveProjectsToken(session);
    const response = await fetch("https://api.zoo.dev/user/projects?limit=50", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await readResponseText(response, MAX_PROJECT_RESPONSE_BYTES);
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = JSON.parse(text) as { message?: string };
        if (typeof payload.message === "string") {
          detail = `${detail} — ${payload.message.slice(0, 200)}`;
        }
      } catch {
        // Keep the bare status when Zoo returns a non-JSON error body.
      }
      if (response.status === 403) {
        detail = projectsForbiddenDetail(source);
      }
      console.warn(
        `Zoo Projects API request failed (${source}): HTTP ${response.status}`,
      );
      return NextResponse.json(
        { error: "Zoo Projects API request failed.", detail },
        { status: 502 },
      );
    }
    const payload: unknown = JSON.parse(text);
    return NextResponse.json(payload);
  } catch (error) {
    console.warn(
      "Zoo Projects API call failed:",
      error instanceof Error ? error.message : error,
    );
    const message =
      error instanceof RequestInputError
        ? error.message
        : "Zoo returned an unreadable project list.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
