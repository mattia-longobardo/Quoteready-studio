import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { getSettings, updateSettings } from "@/lib/platform-store";
import {
  assertSameOrigin,
  inputErrorResponse,
  readJsonObject,
} from "@/lib/request-security";
import { applySettingsUpdate, publicSettings } from "@/lib/user-settings";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    return NextResponse.json(
      publicSettings(await getSettings(session.user.id)),
    );
  } catch (error) {
    return inputErrorResponse(error, "Settings could not be loaded.");
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const body = await readJsonObject(request, 32 * 1024);
    const updated = applySettingsUpdate(
      await getSettings(session.user.id),
      body,
    );
    await updateSettings(session.user.id, updated);
    return NextResponse.json(publicSettings(updated));
  } catch (error) {
    return inputErrorResponse(error, "Settings could not be saved.");
  }
}
