import { NextResponse } from "next/server";

import { buildAuditReport } from "@quoteredy/core/audit";
import { getMaterial } from "@quoteredy/core/materials";
import { buildManufacturingPlan } from "@quoteredy/core/pricing";
import { buildUserWorkshopMemory } from "@quoteredy/core/user-memory";

import { isErrorResponse, requireSession } from "@/lib/api-auth";
import { readPartCad } from "@/lib/artifacts";
import { nextResultTitle } from "@/lib/item-naming";
import {
  getWorkspace,
  saveReport,
  StoreQuotaError,
  updatePart,
} from "@/lib/platform-store";
import {
  assertSameOrigin,
  enforceRateLimit,
  inputErrorResponse,
  readJsonObject,
  RequestInputError,
  withSingleFlight,
} from "@/lib/request-security";
import { findResultPart, metadataWithAttachments } from "@/lib/result-context";
import { getCadFormat } from "@/lib/rfq";
import { settingsWithDefaults } from "@/lib/user-settings";
import { analyzeWithZoo } from "@/lib/zoo";
import { ZooAuthError } from "@/lib/zoo-auth";
import { resolveProjectsToken } from "@/lib/zoo-projects";

export const runtime = "nodejs";

/**
 * Re-run the analysis of an existing result on the 3D part currently attached
 * to it — including any material the user attached in the meantime, which is
 * folded into the RFQ context (notes and drawing evidence).
 *
 * A re-run never overwrites history: it stores a NEW result, linked to the
 * source through `sourceResultId`/`revision`, filed and tagged like it, and
 * carrying the same attachments. The part is re-pointed at the new result so
 * the workspace keeps one part → its latest analysis.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (isErrorResponse(session)) return session;
    enforceRateLimit(`rerun:${session.user.id}`, 4, 60_000);

    const body = await readJsonObject(request, 16 * 1024);
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || id.length > 64) {
      throw new RequestInputError("A valid result ID is required.");
    }

    // Shares the analysis single-flight key so a re-run and a fresh analysis
    // never run concurrently for the same account.
    return await withSingleFlight(`analysis:${session.user.id}`, async () => {
      const workspace = await getWorkspace(session.user.id);
      const previous = workspace.reports.find(
        (item) => item.id === id && !item.trashedAt,
      );
      if (!previous) {
        throw new RequestInputError(
          "The selected analysis result was not found.",
          404,
        );
      }
      const part = findResultPart(
        workspace.parts,
        workspace.reports,
        previous.id,
      );
      if (!part) {
        throw new RequestInputError(
          "This result has no part record any more, so its analysis cannot be re-run. Run a new analysis from the Planner instead.",
          409,
        );
      }
      const cadBytes = await readPartCad(session.user.id, part);
      if (!cadBytes) {
        throw new RequestInputError(
          "The 3D part file of this result is not archived, so the analysis cannot be re-run. Replace the 3D part with a fresh upload first.",
          409,
        );
      }
      const format = getCadFormat(part.fileName) ?? part.format;

      const attachments = previous.attachments ?? [];
      const metadata = metadataWithAttachments(
        previous.report.metadata,
        attachments,
      );
      const material = getMaterial(metadata.material);
      // The /file/* geometry endpoints reject third-party OAuth tokens, so the
      // run uses the resolved token exactly like the first analysis did.
      const { token } = await resolveProjectsToken(session);
      const cadArrayBuffer = cadBytes.buffer.slice(
        cadBytes.byteOffset,
        cadBytes.byteOffset + cadBytes.byteLength,
      ) as ArrayBuffer;

      await updatePart(session.user.id, part.id, { status: "analyzing" });
      try {
        const { metrics, apiTrace } = await analyzeWithZoo({
          file: cadArrayBuffer,
          format,
          densityKgM3: material.densityKgM3,
          token,
        });
        const base = buildAuditReport({
          mode: "zoo",
          file: {
            name: part.fileName,
            format,
            sizeBytes: cadBytes.byteLength,
          },
          metadata,
          metrics,
          apiTrace,
        });
        const manufacturingPlan = await buildManufacturingPlan({
          report: base,
          machines: workspace.machines,
          // The workspace was read before the new result is saved, so the
          // memory reflects only the user's previous analyses.
          memory: buildUserWorkshopMemory(workspace.reports),
          zooAccessToken: token,
        });
        const saved = await saveReport(
          session.user.id,
          { ...base, manufacturingPlan },
          {
            // A re-run is named like any new result — the part plus TODAY's
            // date — so re-running an old analysis reads as today's work; the
            // source result keeps its own title and the lineage below.
            title: nextResultTitle(
              metadata.partName || base.file.name,
              workspace.reports.map((item) => item.title),
              { timeZone: settingsWithDefaults(workspace.settings).timezone },
            ),
            folderId: previous.folderId,
            tags: previous.tags,
            attachments,
            sourceResultId: previous.id,
            revision: (previous.revision ?? 0) + 1,
          },
        );
        await updatePart(session.user.id, part.id, {
          status: "analyzed",
          reportId: saved.id,
        });
        return NextResponse.json(saved, { status: 201 });
      } catch (error) {
        await updatePart(session.user.id, part.id, {
          status: "failed",
        }).catch(() => undefined);
        throw error;
      }
    });
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
    return inputErrorResponse(error, "The analysis could not be re-run.");
  }
}
