import { NextResponse } from "next/server";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { documentLabel } from "@/lib/item-naming";
import { htmlToPdf, PdfUnavailableError } from "@/lib/pdf";
import { getDocument } from "@/lib/platform-store";
import { enforceRateLimit, inputErrorResponse } from "@/lib/request-security";

export const runtime = "nodejs";

function fileName(title: string, extension: string): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} _.-]/gu, "")
      .trim()
      .replaceAll(" ", "-")
      .slice(0, 80) || "report";
  return `${base}.${extension}`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    const { id } = await context.params;
    const document = await getDocument(session.user.id, id);
    if (!document) {
      return NextResponse.json(
        { error: "The document was not found." },
        { status: 404 },
      );
    }
    if (document.status !== "ready") {
      return NextResponse.json(
        {
          error:
            document.status === "generating"
              ? "This report is still being generated."
              : `This report failed to generate: ${document.error ?? "unknown error"}`,
        },
        { status: 409 },
      );
    }
    const format = new URL(request.url).searchParams.get("format");

    if (format === "pdf") {
      enforceRateLimit(`pdf:${session.user.id}`, 6, 60_000);
      const pdf = await htmlToPdf(document.html);
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileName(documentLabel(document), "pdf")}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ document });
  } catch (error) {
    if (error instanceof PdfUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return inputErrorResponse(error, "The document could not be loaded.");
  }
}
