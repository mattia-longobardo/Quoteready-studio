import { NextResponse } from "next/server";

import { getOAuthConfig, readZooSession } from "@/lib/zoo-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getOAuthConfig();
    const session = await readZooSession({ refresh: true });

    return NextResponse.json({
      authenticated: Boolean(session),
      configured: config.configured,
      user: session?.user ?? null,
    });
  } catch {
    return NextResponse.json({
      authenticated: false,
      configured: getOAuthConfig().configured,
      user: null,
    });
  }
}
