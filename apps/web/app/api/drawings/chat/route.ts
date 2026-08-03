import { NextResponse } from "next/server";

import { runCopilotPrompt } from "@quoteredy/core/zoo-copilot";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import {
  DRAWING_CHAT_TIMEOUT_MS,
  drawingChatPrompt,
  drawingTableChanges,
  parseDrawingResponse,
} from "@/lib/drawing-generation";
import { getWorkspace, updateDrawing } from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
  withSingleFlight,
} from "@/lib/request-security";
import { resolveProjectsToken } from "@/lib/zoo-projects";

export const runtime = "nodejs";

/**
 * One turn of the live drawing chat: the Zoo agent applies the user's request
 * to the current drawing table and the updated table is persisted. The turn
 * is synchronous (text-only prompt, no CAD attach) so it stays interactive.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`drawing-chat:${session.user.id}`, 6, 60_000);

    const body = await readJsonObject(request, 16 * 1024);
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!id || id.length > 64) {
      throw new RequestInputError("A valid drawing ID is required.");
    }
    if (!message || message.length > 600) {
      throw new RequestInputError("Write a request of at most 600 characters.");
    }

    const workspace = await getWorkspace(session.user.id);
    const drawing = workspace.drawings.find((item) => item.id === id);
    if (!drawing) {
      throw new RequestInputError("The drawing was not found.", 404);
    }
    if (drawing.status !== "ready") {
      throw new RequestInputError(
        "The drawing table is not ready yet — wait for the generation to finish.",
        409,
      );
    }
    const resolved = await resolveProjectsToken(session);
    if (resolved.source === "oauth") {
      throw new RequestInputError(
        "Zoo's agent endpoints reject third-party OAuth tokens. Add a valid personal Zoo API token in Settings first.",
        409,
      );
    }

    return await withSingleFlight(
      `drawing-chat:${session.user.id}:${id}`,
      async () => {
        const { text } = await runCopilotPrompt({
          token: resolved.token,
          content: drawingChatPrompt(drawing, message),
          projectName: `QuoteReady Studio — drawing chat ${drawing.partName}`,
          forcedTools: [],
          timeoutMs: DRAWING_CHAT_TIMEOUT_MS,
        });
        const parsed = parseDrawingResponse(text);
        const updated = await updateDrawing(session.user.id, drawing.id, {
          status: "ready",
          error: null,
          ...drawingTableChanges(parsed),
        });
        return NextResponse.json({
          drawing: updated ?? drawing,
          reply:
            parsed.reply ||
            "The drawing table was updated according to your request.",
        });
      },
    );
  } catch (error) {
    return inputErrorResponse(
      error,
      "The Zoo agent could not update the drawing.",
    );
  }
}
