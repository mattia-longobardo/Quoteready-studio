import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import {
  createFolder,
  deleteFolder,
  emptyTrash,
  getWorkspace,
  selectReportRoute,
  StoreQuotaError,
  updateReport,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
} from "@/lib/request-security";

export const runtime = "nodejs";

function optionalIdentifier(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new RequestInputError(`${label} is invalid.`);
  }
  return value;
}

function optionalTimestamp(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RequestInputError(`${label} must be an ISO date or null.`);
  }
  return new Date(value).toISOString();
}

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const workspace = await getWorkspace(session.user.id);
  return NextResponse.json({
    folders: workspace.folders,
    reports: workspace.reports,
  });
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    enforceRateLimit(`reports:${session.user.id}`, 40, 60_000);
    const body = await readJsonObject(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) {
      throw new RequestInputError(
        "Folder name is required and cannot exceed 100 characters.",
      );
    }
    const parentId =
      optionalIdentifier(body.parentId, "Parent folder ID") ?? null;
    return NextResponse.json(
      await createFolder(session.user.id, name, parentId),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The report folder could not be created.");
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    enforceRateLimit(`reports:${session.user.id}`, 40, 60_000);
    const body = await readJsonObject(request);
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || id.length > 64)
      throw new RequestInputError("A valid report ID is required.");

    if (typeof body.recommendedRouteId === "string") {
      if (!body.recommendedRouteId || body.recommendedRouteId.length > 80) {
        throw new RequestInputError("The manufacturing route ID is invalid.");
      }
      const selected = await selectReportRoute(
        session.user.id,
        id,
        body.recommendedRouteId,
      );
      return selected
        ? NextResponse.json(selected)
        : NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    const changes: Parameters<typeof updateReport>[2] = {};
    if (body.title !== undefined) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 140
      ) {
        throw new RequestInputError(
          "Report title must contain 1 to 140 characters.",
        );
      }
      changes.title = body.title.trim();
    }
    const folderId = optionalIdentifier(body.folderId, "Folder ID");
    const archivedAt = optionalTimestamp(body.archivedAt, "Archive date");
    const trashedAt = optionalTimestamp(body.trashedAt, "Trash date");
    if (folderId !== undefined) changes.folderId = folderId;
    if (archivedAt !== undefined) changes.archivedAt = archivedAt;
    if (trashedAt !== undefined) changes.trashedAt = trashedAt;
    if (body.tags !== undefined) changes.tags = body.tags as string[];
    if (Object.keys(changes).length === 0) {
      throw new RequestInputError("No supported report change was supplied.");
    }
    const report = await updateReport(session.user.id, id, changes);
    return report
      ? NextResponse.json(report)
      : NextResponse.json({ error: "Report not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The report could not be updated.");
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    assertSameOrigin(request);
    const parameters = new URL(request.url).searchParams;
    const folderId = parameters.get("folderId");
    if (folderId) {
      if (folderId.length > 64) {
        throw new RequestInputError("The folder ID is invalid.");
      }
      const mode = parameters.get("mode");
      if (mode !== "purge" && mode !== "release") {
        throw new RequestInputError(
          "Folder deletion requires mode=purge or mode=release.",
        );
      }
      const outcome = await deleteFolder(session.user.id, folderId, mode);
      if (!outcome) {
        return NextResponse.json(
          { error: "The folder was not found." },
          { status: 404 },
        );
      }
      return NextResponse.json(outcome);
    }
    const scope = parameters.get("scope");
    if (scope !== "trash") {
      throw new RequestInputError("Only scope=trash is supported.");
    }
    const removed = await emptyTrash(session.user.id, "results");
    return NextResponse.json({ removed });
  } catch (error) {
    return inputErrorResponse(error, "The trash could not be emptied.");
  }
}
