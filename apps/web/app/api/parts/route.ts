import { NextResponse } from "next/server";

import { getBlobStore } from "@quoteredy/storage";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { isOverwriteConfirmed, partNameConflictBody } from "@/lib/part-names";
import {
  deletePart,
  getWorkspace,
  PartNameConflictError,
  StoreQuotaError,
  updatePart,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
} from "@/lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const workspace = await getWorkspace(session.user.id);
  return NextResponse.json({ parts: workspace.parts });
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    enforceRateLimit(`parts:${session.user.id}`, 40, 60_000);
    const body = await readJsonObject(request, 16 * 1024);
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || id.length > 64) {
      throw new RequestInputError("A valid part ID is required.");
    }
    const changes: Parameters<typeof updatePart>[2] = {};
    if (body.name !== undefined) {
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.trim().length > 140
      ) {
        throw new RequestInputError(
          "Part name must contain 1 to 140 characters.",
        );
      }
      changes.name = body.name.trim();
    }
    if (Object.keys(changes).length === 0) {
      throw new RequestInputError("No supported part change was supplied.");
    }
    // A rename onto an existing part name needs the user's confirmation: the
    // renamed part takes the name over and the previous holder is superseded
    // (hidden, never deleted). Without the flag the collision is refused.
    const part = await updatePart(session.user.id, id, changes, {
      onNameConflict: isOverwriteConfirmed(body.overwrite)
        ? "supersede"
        : "reject",
    });
    return part
      ? NextResponse.json(part)
      : NextResponse.json({ error: "Part not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof PartNameConflictError) {
      return NextResponse.json(
        partNameConflictBody({
          partId: error.partId,
          partName: error.partName,
          message: `${error.message} Confirm the overwrite to replace it, or choose another name.`,
        }),
        { status: 409 },
      );
    }
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The part could not be updated.");
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id || id.length > 64) {
      throw new RequestInputError("A valid part ID is required.");
    }
    const workspace = await getWorkspace(session.user.id);
    const part = workspace.parts.find((item) => item.id === id);
    const removed = await deletePart(session.user.id, id);
    if (removed && part) {
      // Best-effort cleanup of the part-scoped blobs (preview model and
      // archived CAD); report artifacts stay with their report.
      for (const key of [part.modelBlobKey, part.cadBlobKey]) {
        if (key && key.includes("/parts/")) {
          await getBlobStore()
            .delete(key)
            .catch(() => undefined);
        }
      }
    }
    return removed
      ? NextResponse.json({ removed: true })
      : NextResponse.json({ error: "Part not found." }, { status: 404 });
  } catch (error) {
    return inputErrorResponse(error, "The part could not be removed.");
  }
}
