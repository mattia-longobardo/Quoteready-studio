import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { toSummary } from "@/lib/documents";
import { nextSequentialName, partNameStem } from "@/lib/item-naming";
import {
  emptyTrash,
  getSettings,
  getWorkspace,
  saveDocument,
  StoreQuotaError,
  updateDocument,
} from "@/lib/platform-store";
import { missingKeyError, ReportGenerationError } from "@/lib/report-ai";
import {
  DOCUMENT_GENERATION_STALE_MS,
  generateReportDocument,
} from "@/lib/report-generation";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
  withSingleFlight,
} from "@/lib/request-security";
import { getOpenAiKey, publicSettings } from "@/lib/user-settings";
import { ZooAuthError } from "@/lib/zoo-auth";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const workspace = await getWorkspace(session.user.id);
  return NextResponse.json({ documents: workspace.documents.map(toSummary) });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`report-doc:${session.user.id}`, 3, 60_000);

    const body = await readJsonObject(request, 16 * 1024);
    if (typeof body.resultId !== "string" || !body.resultId) {
      throw new RequestInputError("Select the analysis result to document.");
    }

    return await withSingleFlight(`report-doc:${session.user.id}`, async () => {
      const [workspace, stored] = await Promise.all([
        getWorkspace(session.user.id),
        getSettings(session.user.id),
      ]);
      const result = workspace.reports.find(
        (item) => item.id === body.resultId && !item.trashedAt,
      );
      if (!result) {
        throw new RequestInputError(
          "The selected analysis result was not found.",
          404,
        );
      }
      const settings = publicSettings(stored);
      if (!settings.aiReports.enabled) {
        throw new RequestInputError(
          "Detailed reports are disabled in Settings.",
          409,
        );
      }
      const apiKey = getOpenAiKey(stored);
      if (!apiKey) throw missingKeyError();

      // One generation at a time per result: a fresh "generating" document
      // for the same result blocks a duplicate run until it goes stale.
      const running = workspace.documents.find(
        (item) =>
          item.status === "generating" &&
          item.resultId === result.id &&
          Date.now() - Date.parse(item.updatedAt) <
            DOCUMENT_GENERATION_STALE_MS,
      );
      if (running) {
        throw new RequestInputError(
          "A report is already being generated for this result.",
          409,
        );
      }

      // The AI write takes minutes, so it runs in the background: the
      // document is created as "generating" and the Reports page polls it.
      const document = await saveDocument(session.user.id, {
        resultId: result.id,
        // Sequential per-part label ("USB_Holder_01") so several reports of
        // the same part stay distinguishable in the lists and PDFs.
        name: nextSequentialName(
          partNameStem(result.report.file.name || result.title),
          workspace.documents.map((item) => item.name),
        ),
        title: result.title,
        html: "",
        model: settings.aiReports.model,
        status: "generating",
        tags: result.tags ?? [],
      });
      // Fire-and-forget: generateReportDocument never throws and always
      // writes the outcome (ready or failed) back onto the document.
      void generateReportDocument({
        userId: session.user.id,
        documentId: document.id,
        result,
        settings,
        apiKey,
      });
      return NextResponse.json(toSummary(document), { status: 202 });
    });
  } catch (error) {
    if (error instanceof ReportGenerationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof ZooAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(
      error,
      "The detailed report could not be generated.",
    );
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const body = await readJsonObject(request, 32 * 1024);
    if (typeof body.id !== "string" || !body.id) {
      throw new RequestInputError("A document id is required.");
    }
    const changes: Parameters<typeof updateDocument>[2] = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        throw new RequestInputError("The title cannot be empty.");
      }
      changes.title = body.title.trim().slice(0, 140);
    }
    if (body.folderId !== undefined) {
      if (
        body.folderId !== null &&
        (typeof body.folderId !== "string" ||
          !body.folderId ||
          body.folderId.length > 64)
      ) {
        throw new RequestInputError("The folder ID is invalid.");
      }
      changes.folderId = body.folderId;
    }
    for (const field of ["archivedAt", "trashedAt"] as const) {
      if (body[field] !== undefined) {
        const value = body[field];
        if (value !== null && typeof value !== "string") {
          throw new RequestInputError(
            `${field} must be a date string or null.`,
          );
        }
        changes[field] = value === null ? null : new Date().toISOString();
      }
    }
    if (body.tags !== undefined) {
      changes.tags = body.tags as string[];
    }
    const updated = await updateDocument(session.user.id, body.id, changes);
    if (!updated) {
      return NextResponse.json(
        { error: "The document was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(toSummary(updated));
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The document could not be updated.");
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const scope = new URL(request.url).searchParams.get("scope");
    if (scope !== "trash") {
      throw new RequestInputError("Only scope=trash is supported.");
    }
    const removed = await emptyTrash(session.user.id, "documents");
    return NextResponse.json({ removed });
  } catch (error) {
    return inputErrorResponse(error, "The trash could not be emptied.");
  }
}
