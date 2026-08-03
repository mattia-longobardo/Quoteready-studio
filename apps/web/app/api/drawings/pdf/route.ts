import { NextResponse } from "next/server";

import { getMaterial } from "@quoteredy/core/materials";
import type { StoredPart } from "@quoteredy/core/types";
import { getBlobStore } from "@quoteredy/storage";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { drawingSheetHtml, SHEET_VIEW_AREA } from "@/lib/drawing-sheet";
import {
  buildDrawingViews,
  type DrawingAnnotations,
  type DrawingScale,
} from "@/lib/drawing-views";
import { parseGltfMesh } from "@/lib/gltf-mesh";
import { drawingLabel } from "@/lib/item-naming";
import { htmlToPdf, PdfUnavailableError } from "@/lib/pdf";
import { getWorkspace } from "@/lib/platform-store";
import { enforceRateLimit, inputErrorResponse } from "@/lib/request-security";

export const runtime = "nodejs";

function fileName(title: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} _.-]/gu, "")
      .trim()
      .replaceAll(" ", "-")
      .slice(0, 80) || "drawing";
  return `${base}-drawing.pdf`;
}

/**
 * Project the part's archived glTF into the sheet views. Never throws: a part
 * without a stored model (or with an unreadable one) still gets its drawing
 * sheet, with the reason printed in the drawing area.
 */
async function sheetViews(
  part: StoredPart | undefined,
  /** Datums and tolerance rows the views are annotated from. */
  annotations: DrawingAnnotations,
): Promise<{
  viewsSvg: string;
  scale: DrawingScale | null;
  viewsNote: string;
  /** Bounding box of the model, "X × Y × Z" in millimetres. */
  envelope: string;
  /** Whether the sheet has room for the part-data box under the views. */
  roomForPartData: boolean;
  /** Table rows that ended up ballooned on the views. */
  balloonedRows: number[];
}> {
  const empty = (note: string) => ({
    viewsSvg: "",
    scale: null,
    viewsNote: note,
    envelope: "",
    roomForPartData: false,
    balloonedRows: [],
  });
  if (!part?.modelBlobKey) {
    return empty(
      "No 3D model is archived for this part, so no views could be projected.",
    );
  }
  try {
    const bytes = await getBlobStore().get(part.modelBlobKey);
    const mesh = bytes ? parseGltfMesh(bytes) : null;
    if (!mesh) {
      return empty(
        "The archived 3D model could not be projected into drawing views.",
      );
    }
    const graphics = buildDrawingViews(mesh, SHEET_VIEW_AREA, annotations);
    return {
      viewsSvg: graphics.svg,
      scale: graphics.scale,
      viewsNote: "",
      envelope: mesh.max
        .map((value, axis) => (value - mesh.min[axis]).toFixed(2))
        .join(" × "),
      roomForPartData: graphics.bottomFreeMm >= 30,
      balloonedRows: graphics.balloonedRows,
    };
  } catch (error) {
    console.warn(
      `Drawing views failed for part ${part.id}:`,
      error instanceof Error ? error.message : error,
    );
    return empty("The views of this part could not be projected.");
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id || id.length > 64) {
      return NextResponse.json(
        { error: "A valid drawing ID is required." },
        { status: 400 },
      );
    }
    const workspace = await getWorkspace(session.user.id);
    const drawing = workspace.drawings.find((item) => item.id === id);
    if (!drawing) {
      return NextResponse.json(
        { error: "The drawing was not found." },
        { status: 404 },
      );
    }
    if (drawing.status !== "ready") {
      return NextResponse.json(
        {
          error:
            drawing.status === "generating"
              ? "This drawing table is still being generated."
              : `This drawing table failed to generate: ${drawing.error ?? "unknown error"}`,
        },
        { status: 409 },
      );
    }
    enforceRateLimit(`pdf:${session.user.id}`, 6, 60_000);

    const part = workspace.parts.find((item) => item.id === drawing.partId);
    const report = workspace.reports.find(
      (item) => item.id === part?.reportId,
    )?.report;
    const {
      viewsSvg,
      scale,
      viewsNote,
      envelope,
      roomForPartData,
      balloonedRows,
    } = await sheetViews(part, {
      datums: drawing.datums,
      rows: drawing.rows,
    });
    const units = drawing.units || "mm";
    const metrics = report?.metrics;
    const partData = [
      {
        label: "Envelope X × Y × Z",
        value: envelope ? `${envelope} ${units}` : "",
      },
      {
        label: "Volume",
        value: metrics?.volumeMm3 ? `${metrics.volumeMm3.toFixed(1)} mm³` : "",
      },
      {
        label: "Surface",
        value: metrics?.surfaceAreaMm2
          ? `${metrics.surfaceAreaMm2.toFixed(1)} mm²`
          : "",
      },
      {
        label: "Mass",
        value: metrics?.massG ? `${metrics.massG.toFixed(1)} g` : "",
      },
    ].filter((item) => item.value !== "");
    const html = drawingSheetHtml({
      drawing,
      viewsSvg,
      scale,
      viewsNote,
      // The box sits under the views, so it is only printed when the
      // projection leaves room for it.
      partData: roomForPartData ? partData : [],
      balloonedRows,
      material: getMaterial(report?.metadata.material ?? "unknown").label,
      drawnAt: new Date(),
    });
    const pdf = await htmlToPdf(html, {
      format: "a3",
      landscape: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
      preferCSSPageSize: true,
    });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName(drawingLabel(drawing))}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PdfUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return inputErrorResponse(error, "The drawing PDF could not be created.");
  }
}
