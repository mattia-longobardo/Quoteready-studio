import { NextResponse } from "next/server";

import { getBlobStore, sanitizeBlobFileName } from "@quoteredy/storage";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { storePartCad } from "@/lib/artifacts";
import { parseAnalysisMultipart } from "@/lib/multipart";
import {
  getWorkspace,
  StoreQuotaError,
  updatePart,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  RequestInputError,
} from "@/lib/request-security";
import { findResultPart } from "@/lib/result-context";
import { getCadFormat, isValidCadContent } from "@/lib/rfq";
import { ZooAuthError } from "@/lib/zoo-auth";
import { storePartModel } from "@/lib/zoo-model";
import { resolveProjectsToken } from "@/lib/zoo-projects";

export const runtime = "nodejs";

/**
 * Replace the 3D part attached to an analysis result. The new CAD file goes
 * through the same validation, archival and glTF preview conversion as the
 * original upload; the part is left in "uploaded" so the UI can show that the
 * result is stale until the analysis is re-run.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`result-part:${session.user.id}`, 6, 60_000);

    const upload = await parseAnalysisMultipart(request);
    if (upload.drawing) {
      throw new RequestInputError(
        "Only the CAD file replaces the 3D part; attach drawings as additional material.",
      );
    }
    if (!upload.cadFile) {
      throw new RequestInputError(
        "Select the CAD file that replaces the part.",
      );
    }
    const resultId = (upload.fields.resultId ?? "").trim();
    if (!resultId || resultId.length > 64) {
      throw new RequestInputError("A valid result ID is required.");
    }
    const format = getCadFormat(upload.cadFile.name);
    if (!format) {
      throw new RequestInputError(
        "Use STEP, STL, OBJ, PLY, SLDPRT, IPT, SAT or Parasolid CAD data.",
        415,
      );
    }
    if (!isValidCadContent(upload.cadFile, format)) {
      throw new RequestInputError(
        "The uploaded file content does not match the selected CAD format.",
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
    const part = findResultPart(workspace.parts, workspace.reports, result.id);
    if (!part) {
      throw new RequestInputError(
        "This result has no part record any more, so its 3D file cannot be replaced. Run a new analysis from the Planner instead.",
        409,
      );
    }
    if (part.status === "analyzing") {
      throw new RequestInputError(
        "This part is being analysed right now. Wait for the run to finish before replacing its 3D file.",
        409,
      );
    }

    const fileName = sanitizeBlobFileName(upload.cadFile.name);
    const previousCadKey = part.cadBlobKey ?? null;
    const cadBlobKey = await storePartCad(session.user.id, part.id, {
      ...upload.cadFile,
      name: fileName,
    });
    // The preview conversion is best-effort (it returns null on failure), and
    // overwrites the part's existing glTF key so the 3D view follows the file.
    const { token } = await resolveProjectsToken(session);
    const cadArrayBuffer = upload.cadFile.bytes.buffer.slice(
      upload.cadFile.bytes.byteOffset,
      upload.cadFile.bytes.byteOffset + upload.cadFile.bytes.byteLength,
    ) as ArrayBuffer;
    const modelBlobKey = await storePartModel({
      userId: session.user.id,
      partId: part.id,
      file: cadArrayBuffer,
      format,
      token,
    });

    const updated = await updatePart(session.user.id, part.id, {
      fileName,
      format,
      sizeBytes: upload.cadFile.size,
      cadBlobKey,
      modelBlobKey,
      // "uploaded" marks the part as analysed-but-stale: the result still
      // describes the previous file until the analysis is re-run.
      status: "uploaded",
    });
    if (!updated) {
      return NextResponse.json(
        { error: "The part was not found." },
        { status: 404 },
      );
    }
    // Drop the superseded CAD blob, but never a report artifact: those belong
    // to the stored result that was analysed from them.
    if (
      previousCadKey &&
      previousCadKey !== cadBlobKey &&
      previousCadKey.includes("/parts/")
    ) {
      await getBlobStore()
        .delete(previousCadKey)
        .catch(() => undefined);
    }
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof ZooAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The 3D part could not be replaced.");
  }
}
