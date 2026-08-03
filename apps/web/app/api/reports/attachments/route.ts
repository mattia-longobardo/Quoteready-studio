import { NextResponse } from "next/server";

import { getBlobStore } from "@quoteredy/storage";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { storeResultAttachment } from "@/lib/artifacts";
import { parseAnalysisMultipart } from "@/lib/multipart";
import {
  addResultAttachment,
  getWorkspace,
  removeResultAttachment,
  STORE_LIMITS,
  StoreQuotaError,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  RequestInputError,
} from "@/lib/request-security";
import { isValidDrawingContent } from "@/lib/rfq";

export const runtime = "nodejs";

function identifier(value: string | null, label: string): string {
  const id = value?.trim() ?? "";
  if (!id || id.length > 64) {
    throw new RequestInputError(`A valid ${label} is required.`);
  }
  return id;
}

/** Download the archived bytes of one attachment for its owner. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  try {
    const parameters = new URL(request.url).searchParams;
    const resultId = identifier(parameters.get("resultId"), "result ID");
    const attachmentId = identifier(
      parameters.get("attachmentId"),
      "attachment ID",
    );
    const workspace = await getWorkspace(session.user.id);
    const attachment = workspace.reports
      .find((item) => item.id === resultId)
      ?.attachments?.find((item) => item.id === attachmentId);
    if (!attachment?.blobKey) {
      return NextResponse.json(
        { error: "No stored file was found for this attachment." },
        { status: 404 },
      );
    }
    const bytes = await getBlobStore().get(attachment.blobKey);
    if (!bytes) {
      return NextResponse.json(
        { error: "The attached file is no longer available." },
        { status: 404 },
      );
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": attachment.mediaType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${attachment.fileName.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    return inputErrorResponse(error, "The attachment could not be read.");
  }
}

/**
 * Attach additional material to an analysis result: a supporting drawing or
 * document (multipart field `drawing`), a free-text note (`note`), or both.
 * The material enriches the context of the next analysis re-run and of every
 * detailed report generated from the result.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`result-attachment:${session.user.id}`, 30, 60_000);

    const upload = await parseAnalysisMultipart(request);
    if (upload.cadFile) {
      throw new RequestInputError(
        "Use the 3D part replacement to upload CAD data; attachments accept PDF, PNG or JPEG.",
      );
    }
    const resultId = identifier(upload.fields.resultId ?? null, "result ID");
    const text = (upload.fields.note ?? "").trim();
    if (text.length > STORE_LIMITS.attachmentTextMaxLength) {
      throw new RequestInputError(
        `A note cannot exceed ${STORE_LIMITS.attachmentTextMaxLength} characters.`,
      );
    }
    if (!upload.drawing && !text) {
      throw new RequestInputError(
        "Attach a drawing or document, or write a note.",
      );
    }
    if (upload.drawing && !isValidDrawingContent(upload.drawing)) {
      throw new RequestInputError(
        "An attached drawing or document must contain PDF, PNG or JPEG data.",
        415,
      );
    }

    const workspace = await getWorkspace(session.user.id);
    const result = workspace.reports.find(
      (item) => item.id === resultId && !item.trashedAt,
    );
    if (!result) {
      throw new RequestInputError(
        "The selected analysis result was not found.",
        404,
      );
    }

    const blobKey = upload.drawing
      ? await storeResultAttachment(session.user.id, result.id, upload.drawing)
      : null;
    const saved = await addResultAttachment(session.user.id, result.id, {
      kind: upload.drawing ? "file" : "note",
      text,
      fileName: upload.drawing?.name ?? "",
      mediaType: upload.drawing?.mediaType ?? "",
      sizeBytes: upload.drawing?.size ?? 0,
      blobKey,
    });
    if (!saved) {
      // The result disappeared between the read and the write.
      if (blobKey) {
        await getBlobStore()
          .delete(blobKey)
          .catch(() => undefined);
      }
      return NextResponse.json(
        { error: "The selected analysis result was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json(saved.attachment, { status: 201 });
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The attachment could not be stored.");
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const parameters = new URL(request.url).searchParams;
    const resultId = identifier(parameters.get("resultId"), "result ID");
    const attachmentId = identifier(
      parameters.get("attachmentId"),
      "attachment ID",
    );
    const removed = await removeResultAttachment(
      session.user.id,
      resultId,
      attachmentId,
    );
    if (!removed) {
      return NextResponse.json(
        { error: "The attachment was not found." },
        { status: 404 },
      );
    }
    // A re-run carries the same blob reference onto the new result, so the
    // bytes only go when nothing points at them any more.
    if (removed.attachment.blobKey && !removed.blobShared) {
      await getBlobStore()
        .delete(removed.attachment.blobKey)
        .catch(() => undefined);
    }
    return NextResponse.json({ removed: true });
  } catch (error) {
    return inputErrorResponse(error, "The attachment could not be removed.");
  }
}
