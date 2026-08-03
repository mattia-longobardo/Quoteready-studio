import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { readResponseText } from "@/lib/request-security";
import { resolveProjectsToken } from "@/lib/zoo-projects";

export const runtime = "nodejs";

const ZOO_API_BASE = "https://api.zoo.dev";
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 500;

interface UsagePayload {
  /** Remaining Zoo API credits; Zoo bills API usage per minute, so this is
   * the number of usage minutes still available to the account. */
  minutesRemaining: number | null;
  monthlyCreditsRemaining: number | null;
  stableCreditsRemaining: number | null;
}

const cache = new Map<string, { payload: UsagePayload; fetchedAt: number }>();

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Remaining Zoo usage for the signed-in account, from
 * `GET /user/payment/balance`. Zoo meters API usage in whole minutes and the
 * balance is expressed in credits, so the sum of monthly + stable credits is
 * surfaced as "minutes remaining" in the top bar.
 */
export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;

  const cached = cache.get(session.user.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return NextResponse.json(cached.payload);
  }

  const { token } = await resolveProjectsToken(session);
  let payload: UsagePayload = {
    minutesRemaining: null,
    monthlyCreditsRemaining: null,
    stableCreditsRemaining: null,
  };
  try {
    const response = await fetch(`${ZOO_API_BASE}/user/payment/balance`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await readResponseText(response, 256 * 1024);
    if (response.ok) {
      const balance = JSON.parse(text) as Record<string, unknown>;
      const monthly = asCount(balance.monthly_api_credits_remaining);
      const stable = asCount(balance.stable_api_credits_remaining);
      payload = {
        minutesRemaining:
          monthly === null && stable === null
            ? null
            : (monthly ?? 0) + (stable ?? 0),
        monthlyCreditsRemaining: monthly,
        stableCreditsRemaining: stable,
      };
    } else {
      console.warn(`Zoo balance request failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(
      "Zoo balance request failed:",
      error instanceof Error ? error.message : error,
    );
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(session.user.id, { payload, fetchedAt: Date.now() });
  return NextResponse.json(payload);
}
