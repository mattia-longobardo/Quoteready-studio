import { NextResponse } from "next/server";

import { buildAuditReport } from "@quoteredy/core/audit";
import {
  archiveReportArtifacts,
  reportArtifactKey,
  uploadsPersistenceEnabled,
} from "@/lib/artifacts";
import { nextResultTitle } from "@/lib/item-naming";
import { getMaterial } from "@quoteredy/core/materials";
import { parseAnalysisMultipart } from "@/lib/multipart";
import { isOverwriteConfirmed, partNameConflictBody } from "@/lib/part-names";
import { buildManufacturingPlan } from "@quoteredy/core/pricing";
import {
  buildUserWorkshopMemory,
  type UserWorkshopMemory,
} from "@quoteredy/core/user-memory";
import {
  getWorkspace,
  PartNameConflictError,
  savePart,
  saveReport,
  StoreQuotaError,
  supersedePartsByName,
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
import {
  getCadFormat,
  isValidCadContent,
  isValidDrawingContent,
  parseRfqMetadata,
} from "@/lib/rfq";
import type {
  ApiTrace,
  AuditReport,
  BaseAuditReport,
  GeometryMetrics,
  MachineProfile,
  RfqMetadata,
} from "@quoteredy/core/types";
import { settingsWithDefaults } from "@/lib/user-settings";
import { sanitizeBlobFileName } from "@quoteredy/storage";
import { analyzeWithZoo } from "@/lib/zoo";
import { readZooSession, ZooAuthError, type ZooSession } from "@/lib/zoo-auth";
import { storePartModel } from "@/lib/zoo-model";
import { resolveProjectsToken } from "@/lib/zoo-projects";

export const runtime = "nodejs";

function clientKey(request: Request): string {
  const candidate =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0] ??
    "";
  return (
    candidate
      .trim()
      .replace(/[^0-9a-f:.]/gi, "")
      .slice(0, 64) || "unknown"
  );
}

async function completeReport(
  base: BaseAuditReport,
  session: ZooSession | null,
): Promise<AuditReport> {
  let machines: MachineProfile[] = [];
  let memory: UserWorkshopMemory | undefined;
  let zooToken: string | undefined;
  let existingTitles: (string | undefined)[] = [];
  let timeZone: string | undefined;
  if (session) {
    // The workspace is read before the new report is saved, so the memory
    // reflects only the user's previous analyses.
    const workspace = await getWorkspace(session.user.id);
    machines = workspace.machines;
    memory = buildUserWorkshopMemory(workspace.reports);
    // Titles of every stored result (archived and trashed included) so the new
    // one never duplicates a name a restore could bring back.
    existingTitles = workspace.reports.map((item) => item.title);
    timeZone = settingsWithDefaults(workspace.settings).timezone;
    // Zoo's ML endpoints reject third-party OAuth tokens like the Projects
    // API does, so the plan runs on the resolved (personal API) token.
    zooToken = (await resolveProjectsToken(session)).token;
  }
  const manufacturingPlan = await buildManufacturingPlan({
    report: base,
    machines,
    memory,
    zooAccessToken: zooToken,
  });
  const report: AuditReport = { ...base, manufacturingPlan };
  if (!session) return report;
  // "USB_Holder_2026-07-30", with the lowest free "_NN" when the part was
  // already analysed today.
  const title = nextResultTitle(
    report.metadata.partName || report.file.name,
    existingTitles,
    { timeZone },
  );
  return (await saveReport(session.user.id, report, { title })).report;
}

async function buildDemoReport(
  metadata: RfqMetadata,
  session: ZooSession | null,
): Promise<AuditReport> {
  const density = getMaterial(metadata.material).densityKgM3;
  const volumeMm3 = 18_420;
  const metrics: GeometryMetrics = {
    volumeMm3,
    surfaceAreaMm2: 14_862,
    centerOfMassMm: [42, 30, 6],
    massG: density === null ? null : density * volumeMm3 * 1e-6,
  };
  const apiTrace: ApiTrace[] = [
    {
      endpoint: "Zoo File API",
      status: "skipped",
      durationMs: 0,
      detail:
        "Demo mode uses fixed sample metrics and sends no geometry request.",
    },
  ];
  const base = buildAuditReport({
    mode: "demo",
    file: { name: "demo-bracket.step", format: "step", sizeBytes: 284_112 },
    metadata,
    metrics,
    apiTrace,
  });
  return completeReport(base, session);
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const mode =
      new URL(request.url).searchParams.get("mode") === "demo" ? "demo" : "zoo";
    const session = await readZooSession({ refresh: true });

    if (mode === "demo") {
      enforceRateLimit(
        `demo:${session?.user.id ?? clientKey(request)}`,
        10,
        60_000,
      );
      const body = await readJsonObject(request, 16 * 1024);
      const metadata = parseRfqMetadata(body, false);
      return NextResponse.json(await buildDemoReport(metadata, session));
    }

    if (!session) {
      return NextResponse.json(
        {
          error: "Connect your Zoo account before starting a live analysis.",
          detail:
            "Live geometry requests require a verified Zoo OAuth session.",
        },
        { status: 401 },
      );
    }

    enforceRateLimit(`analysis:${session.user.id}`, 6, 60_000);
    return await withSingleFlight(`analysis:${session.user.id}`, async () => {
      const upload = await parseAnalysisMultipart(request);
      // The overwrite confirmation travels with the RFQ package but is not RFQ
      // metadata, so it is split off before the metadata is validated.
      const { overwrite, ...metadataFields } = upload.fields;
      const overwriteConfirmed = isOverwriteConfirmed(overwrite);
      const metadata = parseRfqMetadata(
        metadataFields,
        Boolean(upload.drawing),
        { requireComplete: true },
      );
      if (!upload.cadFile)
        throw new RequestInputError(
          "Select a CAD file before starting the live analysis.",
        );
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
      if (upload.drawing && !isValidDrawingContent(upload.drawing)) {
        throw new RequestInputError(
          "The supporting drawing must contain PDF, PNG or JPEG data.",
          415,
        );
      }

      const material = getMaterial(metadata.material);
      const cadArrayBuffer = upload.cadFile.bytes.buffer.slice(
        upload.cadFile.bytes.byteOffset,
        upload.cadFile.bytes.byteOffset + upload.cadFile.bytes.byteLength,
      ) as ArrayBuffer;
      // Track the upload as a part so the Parts view can show the analysis
      // in progress.
      const partFileName = sanitizeBlobFileName(upload.cadFile.name);
      const partName = metadata.partName || upload.cadFile.name;
      const part = await savePart(
        session.user.id,
        {
          name: partName,
          fileName: partFileName,
          format,
          sizeBytes: upload.cadFile.size,
          status: "analyzing",
          source: "analysis",
          reportId: null,
          zooProjectId: null,
        },
        // Refused up front — before any Zoo work — unless the user confirmed
        // the overwrite. The part it replaces is only superseded once this
        // analysis has actually produced a result (below), so a failed run
        // never hides the part the user still depends on.
        { onNameConflict: overwriteConfirmed ? "allow" : "reject" },
      );
      try {
        // The /file/* geometry endpoints 403 on third-party OAuth tokens
        // (scope user:read modeling), so all Zoo calls use the resolved
        // token: the verified personal API token when configured.
        const { token: zooToken } = await resolveProjectsToken(session);
        const [{ metrics, apiTrace }, modelBlobKey] = await Promise.all([
          analyzeWithZoo({
            file: cadArrayBuffer,
            format,
            densityKgM3: material.densityKgM3,
            token: zooToken,
          }),
          // Best-effort glTF preview; a conversion failure never blocks the
          // analysis (the helper resolves to null instead of throwing).
          storePartModel({
            userId: session.user.id,
            partId: part.id,
            file: cadArrayBuffer,
            format,
            token: zooToken,
          }),
        ]);
        const base = buildAuditReport({
          mode: "zoo",
          file: {
            name: upload.cadFile.name,
            format,
            sizeBytes: upload.cadFile.size,
          },
          metadata,
          metrics,
          apiTrace,
        });
        const saved = await completeReport(base, session);
        if (saved.id) {
          await archiveReportArtifacts(
            session.user.id,
            saved.id,
            upload.cadFile,
            upload.drawing,
          );
        }
        await updatePart(session.user.id, part.id, {
          status: "analyzed",
          reportId: saved.id ?? null,
          modelBlobKey,
          cadBlobKey:
            saved.id && uploadsPersistenceEnabled()
              ? reportArtifactKey(
                  session.user.id,
                  saved.id,
                  upload.cadFile.name,
                )
              : null,
        });
        if (overwriteConfirmed) {
          // The confirmed overwrite completes here: the parts that carried this
          // name are hidden but kept, blobs included, so their results,
          // drawings and reports keep resolving to the original geometry.
          await supersedePartsByName(session.user.id, partName, part.id);
        }
        return NextResponse.json(saved);
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
    if (error instanceof PartNameConflictError) {
      // The client turns this into the "overwrite it?" confirmation and, if the
      // user agrees, resubmits the same package with overwrite=true.
      return NextResponse.json(
        partNameConflictBody({
          partId: error.partId,
          partName: error.partName,
          message: `${error.message} Confirm the overwrite to replace it, or choose another part name.`,
        }),
        { status: 409 },
      );
    }
    if (error instanceof StoreQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return inputErrorResponse(
      error,
      "QuoteReady Studio could not analyse this RFQ package.",
    );
  }
}
