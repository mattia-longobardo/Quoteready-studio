import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { readPartCad } from "@/lib/artifacts";
import {
  DRAWING_GENERATION_STALE_MS,
  generateDrawingTable,
} from "@/lib/drawing-generation";
import { nextSequentialName, partNameStem } from "@/lib/item-naming";
import {
  deleteDrawing,
  getWorkspace,
  saveDrawing,
  StoreQuotaError,
} from "@/lib/platform-store";
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

export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const workspace = await getWorkspace(session.user.id);
  return NextResponse.json({ drawings: workspace.drawings });
}

/**
 * Start a drawing-table generation for a stored part: the Zoo agent
 * (Zookeeper) picks the datums and tolerances automatically from the archived
 * CAD file. The work runs in the background while the drawing reports
 * status "generating"; the Drawings page polls until it lands.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`drawings:${session.user.id}`, 4, 60_000);

    const body = await readJsonObject(request, 16 * 1024);
    const partId = typeof body.partId === "string" ? body.partId.trim() : "";
    if (!partId || partId.length > 64) {
      throw new RequestInputError("Select the part to detail.");
    }

    return await withSingleFlight(`drawings:${session.user.id}`, async () => {
      const workspace = await getWorkspace(session.user.id);
      const part = workspace.parts.find((item) => item.id === partId);
      if (!part) {
        throw new RequestInputError("The selected part was not found.", 404);
      }
      const running = workspace.drawings.find(
        (item) =>
          item.status === "generating" &&
          item.partId === part.id &&
          Date.now() - Date.parse(item.updatedAt) < DRAWING_GENERATION_STALE_MS,
      );
      if (running) {
        throw new RequestInputError(
          "A drawing table is already being generated for this part.",
          409,
        );
      }
      const cadBytes = await readPartCad(session.user.id, part);
      if (!cadBytes) {
        throw new RequestInputError(
          "The original CAD file is not archived for this part, so Zoo cannot derive its drawing table.",
          409,
        );
      }
      // Zoo's ML endpoints reject third-party OAuth tokens, so a verified
      // personal API token is a hard requirement here.
      const resolved = await resolveProjectsToken(session);
      if (resolved.source === "oauth") {
        throw new RequestInputError(
          "Zoo's agent endpoints reject third-party OAuth tokens. Add a valid personal Zoo API token in Settings first.",
          409,
        );
      }
      const report = workspace.reports.find(
        (item) => item.id === part.reportId,
      )?.report;
      const generalTolerance = report?.metadata.tolerance ?? "";
      // Everything already measured is handed to the agent up front so it can
      // answer without spending minutes re-inspecting the CAD with tools.
      const geometryContext: string[] = [];
      if (report) {
        const { volumeMm3, surfaceAreaMm2, massG } = report.metrics;
        const facts = [
          volumeMm3 !== null ? `volume ${volumeMm3.toFixed(1)} mm³` : "",
          surfaceAreaMm2 !== null
            ? `surface ${surfaceAreaMm2.toFixed(1)} mm²`
            : "",
          massG !== null ? `mass ${massG.toFixed(1)} g` : "",
        ].filter(Boolean);
        if (facts.length > 0) {
          geometryContext.push(`Measured geometry: ${facts.join(", ")}.`);
        }
        if (report.metadata.material !== "unknown") {
          geometryContext.push(`Material: ${report.metadata.material}.`);
        }
        if (report.metadata.units !== "unknown") {
          geometryContext.push(`Design units: ${report.metadata.units}.`);
        }
      }
      const drawing = await saveDrawing(session.user.id, {
        // Sequential per-part label ("USB_Holder_01") so several drawings of
        // the same part stay distinguishable in the lists and PDFs.
        name: nextSequentialName(
          partNameStem(part.fileName || part.name),
          workspace.drawings.map((item) => item.name),
        ),
        partId: part.id,
        partName: part.name,
        fileName: part.fileName,
        status: "generating",
        error: null,
        units: "",
        generalTolerance,
        datums: [],
        rows: [],
        notes: [],
      });
      // Fire-and-forget: generateDrawingTable never throws and always writes
      // the outcome (ready or failed) back onto the drawing record.
      void generateDrawingTable({
        userId: session.user.id,
        drawingId: drawing.id,
        part,
        generalTolerance,
        geometryContext,
        cadBytes,
        token: resolved.token,
      });
      return NextResponse.json(drawing, { status: 202 });
    });
  } catch (error) {
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(error, "The drawing table could not be started.");
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id || id.length > 64) {
      throw new RequestInputError("A valid drawing ID is required.");
    }
    const removed = await deleteDrawing(session.user.id, id);
    if (!removed) {
      return NextResponse.json(
        { error: "The drawing was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ removed: true });
  } catch (error) {
    return inputErrorResponse(error, "The drawing could not be deleted.");
  }
}
