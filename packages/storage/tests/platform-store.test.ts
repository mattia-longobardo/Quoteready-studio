import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { visibleParts } from "@quoteredy/core/parts";
import type { AuditReport, StoredPart } from "@quoteredy/core/types";
import {
  getWorkspaceStore,
  PartNameConflictError,
  STORE_LIMITS,
} from "@quoteredy/storage";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.QUOTE_READY_DATA_DIR;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function isolatedStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "quoteredy-store-test-"));
  directories.push(directory);
  // The factory caches per data directory, so a fresh directory gives an
  // isolated store without resetting module state.
  process.env.QUOTE_READY_DATA_DIR = directory;
  return getWorkspaceStore();
}

const report: AuditReport = {
  mode: "demo",
  score: 100,
  status: "ready",
  summary: "Ready for controlled review.",
  file: { name: "part.step", format: "step", sizeBytes: 1 },
  metadata: {
    partName: "Part",
    process: "cnc_milling",
    material: "aluminum_6061",
    quantity: 1,
    units: "mm",
    tolerance: "±0.1",
    finish: "None",
    notes: "",
    hasDrawing: true,
  },
  metrics: {
    volumeMm3: 1,
    surfaceAreaMm2: 1,
    massG: 1,
    centerOfMassMm: [0, 0, 0],
  },
  checks: [],
  questions: [],
  assumptions: [],
  apiTrace: [],
  manufacturingPlan: {
    provider: "deterministic",
    providerLabel: "Deterministic fallback",
    recommendedRouteId: "route-1",
    summary: "Route",
    generatedAt: new Date(0).toISOString(),
    routes: [
      {
        id: "route-1",
        name: "Route",
        description: "Route",
        suitability: 90,
        availableInFactory: false,
        operations: [],
        price: {
          currency: "EUR",
          minimum: 1,
          expected: 2,
          maximum: 3,
          confidence: 0.5,
        },
        leadTimeHours: 1,
        reasons: [],
        risks: [],
      },
    ],
  },
  generatedAt: new Date(0).toISOString(),
};

function newPart(
  overrides: Partial<StoredPart> = {},
): Omit<StoredPart, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "Bracket",
    fileName: "bracket.step",
    format: "step",
    sizeBytes: 1_024,
    status: "analyzed",
    source: "analysis",
    reportId: null,
    zooProjectId: null,
    ...overrides,
  };
}

describe("workspace persistence invariants", () => {
  it("persists the generated report ID inside the report payload", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    expect(saved.report.id).toBe(saved.id);
    expect((await store.getWorkspace("user-1")).reports[0].report.id).toBe(
      saved.id,
    );
  });

  it("stores the caller's title and falls back to the part name", async () => {
    const store = await isolatedStore();
    const named = await store.saveReport("user-1", report, {
      title: "USB_Holder_2026-07-30",
    });
    expect(named.title).toBe("USB_Holder_2026-07-30");
    const blank = await store.saveReport("user-1", report, { title: "   " });
    expect(blank.title).toBe(report.metadata.partName || report.file.name);
  });

  it("rejects a parent folder that is outside the user workspace", async () => {
    const store = await isolatedStore();
    await expect(
      store.createFolder("user-1", "Child", "foreign-folder"),
    ).rejects.toThrow(/does not exist/);
  });

  it("persists only route IDs that belong to the report", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    await expect(
      store.selectReportRoute("user-1", saved.id, "invented-route"),
    ).rejects.toThrow(/does not belong/);
    const selected = await store.selectReportRoute(
      "user-1",
      saved.id,
      "route-1",
    );
    expect(selected?.report.manufacturingPlan.recommendedRouteId).toBe(
      "route-1",
    );
  });
});

describe("result attachments and re-runs", () => {
  const fileAttachment = {
    kind: "file" as const,
    text: "Rev B",
    fileName: "drawing.pdf",
    mediaType: "application/pdf",
    sizeBytes: 2_048,
    blobKey: "users/user-1/reports/r/attachments/k/drawing.pdf",
  };

  it("round-trips attached files and notes on a stored result", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    expect(saved.attachments).toBeUndefined();

    const file = await store.addResultAttachment("user-1", saved.id, {
      ...fileAttachment,
    });
    const note = await store.addResultAttachment("user-1", saved.id, {
      kind: "note",
      text: "Thread M6 both holes",
      fileName: "",
      mediaType: "",
      sizeBytes: 0,
      blobKey: null,
    });
    expect(file?.attachment.id).toBeTruthy();
    expect(note?.attachment.kind).toBe("note");

    const reloaded = (await store.getWorkspace("user-1")).reports[0];
    expect(reloaded.attachments?.map((item) => item.fileName)).toEqual([
      "drawing.pdf",
      "",
    ]);
    expect(reloaded.attachments?.[0].blobKey).toBe(fileAttachment.blobKey);
    expect(reloaded.updatedAt >= saved.updatedAt).toBe(true);
    expect(
      await store.addResultAttachment("user-1", "missing", {
        ...fileAttachment,
      }),
    ).toBeNull();
  });

  it("bounds note length and the number of attachments per result", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    const long = await store.addResultAttachment("user-1", saved.id, {
      kind: "note",
      text: "x".repeat(9_000),
      fileName: "",
      mediaType: "",
      sizeBytes: 0,
      blobKey: null,
    });
    expect(long?.attachment.text).toHaveLength(
      STORE_LIMITS.attachmentTextMaxLength,
    );
    for (let index = 1; index < STORE_LIMITS.attachmentsPerResult; index += 1) {
      await store.addResultAttachment("user-1", saved.id, {
        kind: "note",
        text: `note ${index}`,
        fileName: "",
        mediaType: "",
        sizeBytes: 0,
        blobKey: null,
      });
    }
    await expect(
      store.addResultAttachment("user-1", saved.id, {
        kind: "note",
        text: "one too many",
        fileName: "",
        mediaType: "",
        sizeBytes: 0,
        blobKey: null,
      }),
    ).rejects.toThrow(/at most/);
  });

  it("reports whether a removed attachment still shares its blob", async () => {
    const store = await isolatedStore();
    const first = await store.saveReport("user-1", report);
    const added = await store.addResultAttachment("user-1", first.id, {
      ...fileAttachment,
    });
    const attachments = [added!.attachment];
    // A re-run copies the same references onto the new result.
    const second = await store.saveReport("user-1", report, {
      attachments,
      sourceResultId: first.id,
      revision: 1,
    });

    const shared = await store.removeResultAttachment(
      "user-1",
      first.id,
      attachments[0].id,
    );
    expect(shared?.blobShared).toBe(true);
    const last = await store.removeResultAttachment(
      "user-1",
      second.id,
      attachments[0].id,
    );
    expect(last?.blobShared).toBe(false);
    expect(
      await store.removeResultAttachment("user-1", first.id, "missing"),
    ).toBeNull();
    const workspace = await store.getWorkspace("user-1");
    expect(workspace.reports.every((item) => !item.attachments?.length)).toBe(
      true,
    );
  });

  it("stores a re-run as a new result linked to its source", async () => {
    const store = await isolatedStore();
    const folder = await store.createFolder("user-1", "Brackets", null);
    const first = await store.saveReport("user-1", report);
    await store.updateReport("user-1", first.id, {
      folderId: folder.id,
      tags: ["bracket"],
    });
    const added = await store.addResultAttachment("user-1", first.id, {
      ...fileAttachment,
    });
    const second = await store.saveReport("user-1", report, {
      folderId: folder.id,
      tags: ["bracket"],
      attachments: [added!.attachment],
      sourceResultId: first.id,
      revision: 1,
    });

    expect(second.sourceResultId).toBe(first.id);
    expect(second.revision).toBe(1);
    expect(second.folderId).toBe(folder.id);
    expect(second.tags).toEqual(["bracket"]);
    expect(second.attachments).toHaveLength(1);
    // The source result is untouched: a re-run never overwrites history.
    const workspace = await store.getWorkspace("user-1");
    expect(workspace.reports).toHaveLength(2);
    expect(
      workspace.reports.find((item) => item.id === first.id)?.attachments,
    ).toHaveLength(1);
    await expect(
      store.saveReport("user-1", report, { folderId: "foreign-folder" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("keeps loading results stored before attachments existed", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    expect(saved.attachments).toBeUndefined();
    // A result written before attachments existed simply has no such key; a
    // corrupted value must not break the whole workspace load either.
    const storePath = path.join(
      process.env.QUOTE_READY_DATA_DIR ?? "",
      "platform.json",
    );
    const raw = JSON.parse(await readFile(storePath, "utf8")) as {
      users: Record<string, { reports: Record<string, unknown>[] }>;
    };
    const reports = raw.users["user-1"].reports;
    reports.push({ ...reports[0], id: "corrupt", attachments: "not-an-array" });
    await writeFile(storePath, JSON.stringify(raw));

    const workspace = await store.getWorkspace("user-1");
    expect(workspace.reports[0].attachments).toBeUndefined();
    expect(workspace.reports[1].attachments).toEqual([]);
  });
});

describe("documents, tags and trash", () => {
  it("stores tags normalized and deduplicated", async () => {
    const store = await isolatedStore();
    const saved = await store.saveReport("user-1", report);
    const updated = await store.updateReport("user-1", saved.id, {
      tags: [" bracket ", "bracket", "Aluminium!", ""],
    });
    expect(updated?.tags).toEqual(["bracket", "Aluminium"]);
  });

  it("saves documents and empties only the trashed ones", async () => {
    const store = await isolatedStore();
    const kept = await store.saveDocument("user-1", {
      resultId: null,
      title: "Kept",
      html: "<!doctype html><html><body>ok</body></html>",
      model: "gpt-4o",
    });
    const trashed = await store.saveDocument("user-1", {
      resultId: null,
      title: "Trashed",
      html: "<!doctype html><html><body>gone</body></html>",
      model: "gpt-4o",
    });
    await store.updateDocument("user-1", trashed.id, {
      trashedAt: new Date().toISOString(),
    });
    expect(await store.emptyTrash("user-1", "documents")).toBe(1);
    const workspace = await store.getWorkspace("user-1");
    expect(workspace.documents.map((item) => item.id)).toEqual([kept.id]);
  });

  it("files generated documents in the source result's folder and mirrors moves", async () => {
    const store = await isolatedStore();
    const folder = await store.createFolder("user-1", "Brackets", null);
    const other = await store.createFolder("user-1", "Housings", null);
    const saved = await store.saveReport("user-1", report);
    await store.updateReport("user-1", saved.id, { folderId: folder.id });
    const document = await store.saveDocument("user-1", {
      resultId: saved.id,
      title: "Dossier",
      html: "<p>ok</p>",
      model: "gpt-4o",
    });
    expect(document.folderId).toBe(folder.id);

    await store.updateReport("user-1", saved.id, { folderId: other.id });
    const workspace = await store.getWorkspace("user-1");
    expect(workspace.documents[0].folderId).toBe(other.id);
  });

  it("deletes a folder purging or releasing its contents", async () => {
    const store = await isolatedStore();
    const folder = await store.createFolder("user-1", "Doomed", null);
    const kept = await store.saveReport("user-1", report);
    const filed = await store.saveReport("user-1", report);
    await store.updateReport("user-1", filed.id, { folderId: folder.id });
    await store.saveDocument("user-1", {
      resultId: filed.id,
      title: "Dossier",
      html: "<p>ok</p>",
      model: "gpt-4o",
    });

    const released = await store.deleteFolder("user-1", folder.id, "release");
    expect(released).toEqual({ removedReports: 0, removedDocuments: 0 });
    let workspace = await store.getWorkspace("user-1");
    expect(workspace.folders).toHaveLength(0);
    expect(workspace.reports.every((item) => item.folderId === null)).toBe(
      true,
    );
    expect(workspace.documents[0].folderId).toBeNull();

    const again = await store.createFolder("user-1", "Doomed", null);
    await store.updateReport("user-1", filed.id, { folderId: again.id });
    const purged = await store.deleteFolder("user-1", again.id, "purge");
    expect(purged).toEqual({ removedReports: 1, removedDocuments: 1 });
    workspace = await store.getWorkspace("user-1");
    expect(workspace.reports.map((item) => item.id)).toEqual([kept.id]);
    expect(workspace.documents).toHaveLength(0);
    expect(await store.deleteFolder("user-1", "missing", "purge")).toBeNull();
  });

  it("tracks parts through analysis", async () => {
    const store = await isolatedStore();
    const part = await store.savePart("user-1", {
      name: "Bracket",
      fileName: "bracket.step",
      format: "step",
      sizeBytes: 10,
      status: "analyzing",
      source: "analysis",
      reportId: null,
      zooProjectId: null,
    });
    const updated = await store.updatePart("user-1", part.id, {
      status: "analyzed",
      reportId: "report-1",
      modelBlobKey: "users/user-1/parts/p/model.glb",
    });
    expect(updated?.status).toBe("analyzed");
    expect(updated?.reportId).toBe("report-1");
    expect(await store.deletePart("user-1", part.id)).toBe(true);
    expect((await store.getWorkspace("user-1")).parts).toHaveLength(0);
  });

  it("replaces the CAD identity of a part", async () => {
    const store = await isolatedStore();
    const part = await store.savePart("user-1", {
      name: "Bracket",
      fileName: "bracket.step",
      format: "step",
      sizeBytes: 10,
      status: "analyzed",
      source: "analysis",
      reportId: "report-1",
      zooProjectId: null,
      cadBlobKey: "users/user-1/parts/p/source/bracket.step",
    });
    const updated = await store.updatePart("user-1", part.id, {
      fileName: "bracket-rev-b.step",
      format: "step",
      sizeBytes: 4_096,
      cadBlobKey: "users/user-1/parts/p/source/bracket-rev-b.step",
      status: "uploaded",
    });
    expect(updated?.fileName).toBe("bracket-rev-b.step");
    expect(updated?.sizeBytes).toBe(4_096);
    expect(updated?.status).toBe("uploaded");
    expect((await store.getWorkspace("user-1")).parts[0].fileName).toBe(
      "bracket-rev-b.step",
    );
  });

  it("keeps parts written before the overwrite feature untouched", async () => {
    const store = await isolatedStore();
    const part = await store.savePart("user-1", newPart({ name: "Bracket" }));
    // Additive-only fields: a plain upload writes no supersede keys at all, so
    // workspaces stored before this feature keep the exact same record shape.
    const raw = JSON.parse(
      await readFile(
        path.join(process.env.QUOTE_READY_DATA_DIR ?? "", "platform.json"),
        "utf8",
      ),
    ) as { users: Record<string, { parts: Record<string, unknown>[] }> };
    expect(Object.hasOwn(raw.users["user-1"].parts[0], "supersededAt")).toBe(
      false,
    );
    expect(Object.hasOwn(raw.users["user-1"].parts[0], "replacedById")).toBe(
      false,
    );
    expect(visibleParts([part])).toHaveLength(1);
  });

  it("persists settings per user", async () => {
    const store = await isolatedStore();
    await store.updateSettings("user-1", {
      timezone: "Europe/Rome",
      currency: "EUR",
      theme: "dark",
      aiReports: { enabled: false, model: "gpt-4o" },
      aiApiKeySealed: "sealed",
      zooApiTokenSealed: null,
    });
    const settings = await store.getSettings("user-1");
    expect(settings?.aiReports.enabled).toBe(false);
    expect(await store.getSettings("user-2")).toBeNull();
  });
});

describe("duplicate part names", () => {
  it("refuses a name another visible part already carries", async () => {
    const store = await isolatedStore();
    const first = await store.savePart("user-1", newPart({ name: "Bracket" }));

    // Case and surrounding whitespace do not make a new name.
    const rejected = await store
      .savePart("user-1", newPart({ name: "  bracket " }), {
        onNameConflict: "reject",
      })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PartNameConflictError);
    expect((rejected as PartNameConflictError).partId).toBe(first.id);
    expect((rejected as PartNameConflictError).partName).toBe("Bracket");
    // Nothing was written, and a genuinely different name still passes.
    expect((await store.getWorkspace("user-1")).parts).toHaveLength(1);
    await store.savePart("user-1", newPart({ name: "Housing" }), {
      onNameConflict: "reject",
    });
    expect((await store.getWorkspace("user-1")).parts).toHaveLength(2);
  });

  it("keeps the historical behaviour when no policy is given", async () => {
    const store = await isolatedStore();
    await store.savePart("user-1", newPart({ name: "Bracket" }));
    await store.savePart("user-1", newPart({ name: "Bracket" }));
    expect((await store.getWorkspace("user-1")).parts).toHaveLength(2);
  });

  it("supersedes the replaced part instead of deleting it", async () => {
    const store = await isolatedStore();
    const original = await store.savePart(
      "user-1",
      newPart({
        name: "Bracket",
        reportId: "report-1",
        cadBlobKey: "users/user-1/parts/original/source/bracket.step",
        modelBlobKey: "users/user-1/parts/original/model.glb",
      }),
    );
    // The overwrite is only applied once the new analysis produced its part.
    const replacement = await store.savePart(
      "user-1",
      newPart({ name: "Bracket", reportId: "report-2" }),
    );
    const superseded = await store.supersedePartsByName(
      "user-1",
      "bracket",
      replacement.id,
    );
    expect(superseded.map((item) => item.id)).toEqual([original.id]);

    const parts = (await store.getWorkspace("user-1")).parts;
    const stored = parts.find((item) => item.id === original.id);
    // The old record and its blobs survive so the results, drawings and reports
    // generated from it still resolve to the original geometry.
    expect(stored?.supersededAt).toBeTruthy();
    expect(stored?.replacedById).toBe(replacement.id);
    expect(stored?.reportId).toBe("report-1");
    expect(stored?.cadBlobKey).toBe(
      "users/user-1/parts/original/source/bracket.step",
    );
    expect(stored?.modelBlobKey).toBe("users/user-1/parts/original/model.glb");
    // Only the new part is visible, and it kept the name.
    expect(visibleParts(parts).map((item) => item.id)).toEqual([
      replacement.id,
    ]);
    expect(visibleParts(parts)[0].name).toBe("Bracket");
    // A superseded part no longer collides with the name it used to hold.
    const third = await store.savePart(
      "user-1",
      newPart({ name: "Bracket 2" }),
    );
    await expect(
      store.updatePart(
        "user-1",
        third.id,
        { name: "Bracket" },
        { onNameConflict: "reject" },
      ),
    ).rejects.toThrow(PartNameConflictError);
    expect(
      (
        await store.updatePart(
          "user-1",
          replacement.id,
          { name: "Bracket" },
          { onNameConflict: "reject" },
        )
      )?.name,
    ).toBe("Bracket");
  });

  it("renames onto an existing name only when the overwrite is confirmed", async () => {
    const store = await isolatedStore();
    const bracket = await store.savePart(
      "user-1",
      newPart({ name: "Bracket" }),
    );
    const housing = await store.savePart(
      "user-1",
      newPart({ name: "Housing", fileName: "housing.step" }),
    );

    await expect(
      store.updatePart(
        "user-1",
        housing.id,
        { name: "BRACKET" },
        { onNameConflict: "reject" },
      ),
    ).rejects.toThrow(PartNameConflictError);
    expect(
      (await store.getWorkspace("user-1")).parts.find(
        (item) => item.id === housing.id,
      )?.name,
    ).toBe("Housing");

    const renamed = await store.updatePart(
      "user-1",
      housing.id,
      { name: "BRACKET" },
      { onNameConflict: "supersede" },
    );
    expect(renamed?.name).toBe("BRACKET");
    const parts = (await store.getWorkspace("user-1")).parts;
    expect(visibleParts(parts).map((item) => item.id)).toEqual([housing.id]);
    expect(parts.find((item) => item.id === bracket.id)?.replacedById).toBe(
      housing.id,
    );
  });

  it("never treats a part's own name as a conflict", async () => {
    const store = await isolatedStore();
    const part = await store.savePart("user-1", newPart({ name: "Bracket" }));
    // Re-casing and re-saving the same name are both legitimate renames.
    const recased = await store.updatePart(
      "user-1",
      part.id,
      { name: "BRACKET" },
      { onNameConflict: "reject" },
    );
    expect(recased?.name).toBe("BRACKET");
    // Unrelated updates carry no name and are never checked.
    const analysed = await store.updatePart("user-1", part.id, {
      status: "analyzing",
    });
    expect(analysed?.supersededAt).toBeUndefined();
    expect(
      visibleParts((await store.getWorkspace("user-1")).parts),
    ).toHaveLength(1);
  });
});
