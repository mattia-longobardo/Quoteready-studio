import { randomUUID } from "node:crypto";
import path from "node:path";

import { samePartName, visibleParts } from "@quoteredy/core/parts";
import type {
  AuditReport,
  DrawingTable,
  MachineProfile,
  ReportDocument,
  ReportFolder,
  ResultAttachment,
  StoredPart,
  StoredReport,
  StoredUserSettings,
} from "@quoteredy/core/types";

import { JsonWorkspaceDriver } from "./json-driver";
import {
  assertWorkspaceQuotas,
  emptyWorkspace,
  normalizeTags,
  STORE_LIMITS,
  StoreConfigurationError,
  StoreQuotaError,
  type UserWorkspace,
  type WorkspaceStoreDriver,
} from "./model";
import { PostgresWorkspaceDriver } from "./postgres-driver";

/**
 * Provenance carried onto a result produced by re-running an earlier analysis:
 * the new result stays filed and tagged like its source and keeps the same
 * attached material, so a re-run reads as a new revision of the same work.
 */
export interface SaveReportOptions {
  /**
   * Title of the new result. Callers compute it (the "<part>_<date>" scheme
   * lives in the web app); omitting it keeps the historical part-name title.
   */
  title?: string;
  folderId?: string | null;
  tags?: string[];
  attachments?: readonly ResultAttachment[];
  /** Result this analysis was re-run from. */
  sourceResultId?: string | null;
  /** 1-based re-run counter; defaults to 1 when a source is given. */
  revision?: number;
}

/**
 * What to do when a part name is already taken by another visible part:
 *
 * - `allow` — keep both records (the historical behaviour, still used by the
 *   Zoo library upload where the part record is best-effort bookkeeping).
 * - `reject` — refuse the write with a {@link PartNameConflictError}, so the
 *   caller can ask the user to confirm the overwrite.
 * - `supersede` — the confirmed overwrite: the colliding part is hidden and
 *   marked as replaced, keeping its record and blobs for the results, drawings
 *   and reports already generated from it.
 */
export type PartNameConflictPolicy = "allow" | "reject" | "supersede";

export interface PartNameOptions {
  /** Duplicate-name policy; defaults to `allow` for backwards compatibility. */
  onNameConflict?: PartNameConflictPolicy;
}

/**
 * A part name is already used by another visible part. Carries the colliding
 * record so the API layer can name it in the confirmation prompt.
 */
export class PartNameConflictError extends Error {
  readonly partId: string;
  readonly partName: string;

  constructor(part: Pick<StoredPart, "id" | "name">) {
    super(`A part named "${part.name}" already exists in this workspace.`);
    this.name = "PartNameConflictError";
    this.partId = part.id;
    this.partName = part.name;
  }
}

/**
 * Domain operations shared by every persistence driver. Quotas and ownership
 * rules are enforced here so JSON and Postgres deployments behave identically.
 */
export class WorkspaceStore {
  constructor(private readonly driver: WorkspaceStoreDriver) {}

  private mutate<T>(
    userId: string,
    operation: (workspace: UserWorkspace) => T | Promise<T>,
  ): Promise<T> {
    return this.driver.mutate(userId, async (workspace) => {
      const value = await operation(workspace);
      assertWorkspaceQuotas(workspace);
      return value;
    });
  }

  async getWorkspace(userId: string): Promise<UserWorkspace> {
    return (await this.driver.read(userId)) ?? emptyWorkspace();
  }

  async saveReport(
    userId: string,
    report: AuditReport,
    options: SaveReportOptions = {},
  ): Promise<StoredReport> {
    return this.mutate(userId, (workspace) => {
      if (workspace.reports.length >= STORE_LIMITS.reportsPerUser) {
        throw new StoreQuotaError(
          `Archive or delete a report before creating more than ${STORE_LIMITS.reportsPerUser}.`,
        );
      }
      if (
        options.folderId &&
        !workspace.folders.some((folder) => folder.id === options.folderId)
      ) {
        throw new StoreQuotaError(
          "The selected report folder does not exist in this workspace.",
        );
      }
      const timestamp = new Date().toISOString();
      const id = randomUUID();
      const stored: StoredReport = {
        id,
        title: (
          options.title?.trim() ||
          report.metadata.partName ||
          report.file.name
        ).slice(0, 140),
        folderId: options.folderId ?? null,
        report: { ...report, id },
        archivedAt: null,
        trashedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // Provenance keys are only written when they apply, so a plain analysis
      // keeps producing exactly the record shape it always produced.
      if (options.tags?.length) stored.tags = normalizeTags(options.tags);
      if (options.attachments?.length) {
        stored.attachments = options.attachments.map((item) => ({ ...item }));
      }
      if (options.sourceResultId) {
        stored.sourceResultId = options.sourceResultId;
        stored.revision = options.revision ?? 1;
      }
      workspace.reports.unshift(stored);
      return stored;
    });
  }

  /**
   * Attach extra material (a stored drawing/document, or a free-text note) to
   * an analysis result. The file bytes live in the blob store; only the
   * reference is recorded here.
   */
  async addResultAttachment(
    userId: string,
    reportId: string,
    input: Omit<ResultAttachment, "id" | "createdAt">,
  ): Promise<{ report: StoredReport; attachment: ResultAttachment } | null> {
    return this.mutate(userId, (workspace) => {
      const report = workspace.reports.find((item) => item.id === reportId);
      if (!report) return null;
      const attachments = report.attachments ?? [];
      if (attachments.length >= STORE_LIMITS.attachmentsPerResult) {
        throw new StoreQuotaError(
          `A result can carry at most ${STORE_LIMITS.attachmentsPerResult} attachments.`,
        );
      }
      const timestamp = new Date().toISOString();
      const attachment: ResultAttachment = {
        ...input,
        text: input.text.slice(0, STORE_LIMITS.attachmentTextMaxLength),
        id: randomUUID(),
        createdAt: timestamp,
      };
      report.attachments = [...attachments, attachment];
      report.updatedAt = timestamp;
      return { report, attachment };
    });
  }

  /**
   * Detach material from a result. `blobShared` reports whether the same blob
   * is still referenced elsewhere (a re-run copies the references onto the new
   * result), so the caller only deletes bytes nothing points at any more.
   */
  async removeResultAttachment(
    userId: string,
    reportId: string,
    attachmentId: string,
  ): Promise<{ attachment: ResultAttachment; blobShared: boolean } | null> {
    return this.mutate(userId, (workspace) => {
      const report = workspace.reports.find((item) => item.id === reportId);
      const attachment = report?.attachments?.find(
        (item) => item.id === attachmentId,
      );
      if (!report || !attachment) return null;
      report.attachments = (report.attachments ?? []).filter(
        (item) => item.id !== attachmentId,
      );
      report.updatedAt = new Date().toISOString();
      const blobShared = workspace.reports.some((item) =>
        (item.attachments ?? []).some(
          (candidate) =>
            Boolean(attachment.blobKey) &&
            candidate.blobKey === attachment.blobKey,
        ),
      );
      return { attachment, blobShared };
    });
  }

  async updateReport(
    userId: string,
    id: string,
    changes: Partial<
      Pick<
        StoredReport,
        "title" | "folderId" | "archivedAt" | "trashedAt" | "tags"
      >
    >,
  ): Promise<StoredReport | null> {
    return this.mutate(userId, (workspace) => {
      const report = workspace.reports.find((item) => item.id === id);
      if (!report) return null;
      if (
        changes.folderId &&
        !workspace.folders.some((folder) => folder.id === changes.folderId)
      ) {
        throw new StoreQuotaError(
          "The selected report folder does not exist in this workspace.",
        );
      }
      if (changes.tags !== undefined) {
        changes = { ...changes, tags: normalizeTags(changes.tags) };
      }
      const timestamp = new Date().toISOString();
      Object.assign(report, changes, { updatedAt: timestamp });
      // Documents mirror their source result's folder placement.
      if (changes.folderId !== undefined) {
        for (const document of workspace.documents) {
          if (document.resultId === id) {
            document.folderId = changes.folderId ?? null;
            document.updatedAt = timestamp;
          }
        }
      }
      return report;
    });
  }

  async saveDocument(
    userId: string,
    input: Pick<
      ReportDocument,
      "resultId" | "name" | "title" | "html" | "model"
    > & {
      tags?: string[];
      status?: ReportDocument["status"];
    },
  ): Promise<ReportDocument> {
    return this.mutate(userId, (workspace) => {
      if (workspace.documents.length >= STORE_LIMITS.documentsPerUser) {
        throw new StoreQuotaError(
          `Trash a report before creating more than ${STORE_LIMITS.documentsPerUser}.`,
        );
      }
      if (
        Buffer.byteLength(input.html, "utf8") >
        STORE_LIMITS.documentHtmlMaxBytes
      ) {
        throw new StoreQuotaError(
          "The generated report exceeds the size safety limit.",
        );
      }
      const timestamp = new Date().toISOString();
      const document: ReportDocument = {
        id: randomUUID(),
        resultId: input.resultId,
        // A generated report lands in the same folder as its source result.
        folderId:
          workspace.reports.find((item) => item.id === input.resultId)
            ?.folderId ?? null,
        name: input.name?.slice(0, 140),
        title: input.title.slice(0, 140),
        html: input.html,
        model: input.model.slice(0, 80),
        status: input.status ?? "ready",
        error: null,
        tags: input.tags ? normalizeTags(input.tags) : [],
        archivedAt: null,
        trashedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      workspace.documents.unshift(document);
      return document;
    });
  }

  async getDocument(
    userId: string,
    id: string,
  ): Promise<ReportDocument | null> {
    const workspace = await this.getWorkspace(userId);
    return workspace.documents.find((item) => item.id === id) ?? null;
  }

  async updateDocument(
    userId: string,
    id: string,
    changes: Partial<
      Pick<
        ReportDocument,
        | "title"
        | "folderId"
        | "archivedAt"
        | "trashedAt"
        | "tags"
        | "html"
        | "status"
        | "error"
      >
    >,
  ): Promise<ReportDocument | null> {
    return this.mutate(userId, (workspace) => {
      const document = workspace.documents.find((item) => item.id === id);
      if (!document) return null;
      if (
        changes.folderId &&
        !workspace.folders.some((folder) => folder.id === changes.folderId)
      ) {
        throw new StoreQuotaError(
          "The selected report folder does not exist in this workspace.",
        );
      }
      if (changes.tags !== undefined) {
        changes = { ...changes, tags: normalizeTags(changes.tags) };
      }
      if (
        changes.html !== undefined &&
        Buffer.byteLength(changes.html, "utf8") >
          STORE_LIMITS.documentHtmlMaxBytes
      ) {
        throw new StoreQuotaError(
          "The generated report exceeds the size safety limit.",
        );
      }
      Object.assign(document, changes, {
        updatedAt: new Date().toISOString(),
      });
      return document;
    });
  }

  /** Record a new drawing table (usually in the "generating" state). */
  async saveDrawing(
    userId: string,
    input: Omit<DrawingTable, "id" | "createdAt" | "updatedAt">,
  ): Promise<DrawingTable> {
    return this.mutate(userId, (workspace) => {
      if (workspace.drawings.length >= STORE_LIMITS.drawingsPerUser) {
        throw new StoreQuotaError(
          `Delete a drawing table before creating more than ${STORE_LIMITS.drawingsPerUser}.`,
        );
      }
      const timestamp = new Date().toISOString();
      const drawing: DrawingTable = {
        ...input,
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      workspace.drawings.unshift(drawing);
      return drawing;
    });
  }

  async updateDrawing(
    userId: string,
    id: string,
    changes: Partial<
      Pick<
        DrawingTable,
        | "status"
        | "error"
        | "units"
        | "generalTolerance"
        | "datums"
        | "rows"
        | "notes"
      >
    >,
  ): Promise<DrawingTable | null> {
    return this.mutate(userId, (workspace) => {
      const drawing = workspace.drawings.find((item) => item.id === id);
      if (!drawing) return null;
      Object.assign(drawing, changes, { updatedAt: new Date().toISOString() });
      return drawing;
    });
  }

  async deleteDrawing(userId: string, id: string): Promise<boolean> {
    return this.mutate(userId, (workspace) => {
      const previousLength = workspace.drawings.length;
      workspace.drawings = workspace.drawings.filter((item) => item.id !== id);
      return workspace.drawings.length !== previousLength;
    });
  }

  /** Permanently delete every trashed item in the collection. */
  async emptyTrash(
    userId: string,
    collection: "results" | "documents",
  ): Promise<number> {
    return this.mutate(userId, (workspace) => {
      if (collection === "results") {
        const before = workspace.reports.length;
        workspace.reports = workspace.reports.filter((item) => !item.trashedAt);
        return before - workspace.reports.length;
      }
      const before = workspace.documents.length;
      workspace.documents = workspace.documents.filter(
        (item) => !item.trashedAt,
      );
      return before - workspace.documents.length;
    });
  }

  async getSettings(userId: string): Promise<StoredUserSettings | null> {
    return (await this.getWorkspace(userId)).settings;
  }

  async updateSettings(
    userId: string,
    settings: StoredUserSettings,
  ): Promise<StoredUserSettings> {
    return this.mutate(userId, (workspace) => {
      workspace.settings = settings;
      return settings;
    });
  }

  async selectReportRoute(
    userId: string,
    reportId: string,
    routeId: string,
  ): Promise<StoredReport | null> {
    return this.mutate(userId, (workspace) => {
      const stored = workspace.reports.find((item) => item.id === reportId);
      if (!stored) return null;
      if (
        !stored.report.manufacturingPlan.routes.some(
          (route) => route.id === routeId,
        )
      ) {
        throw new StoreQuotaError(
          "The selected manufacturing route does not belong to this report.",
        );
      }
      stored.report.manufacturingPlan.recommendedRouteId = routeId;
      stored.report.manufacturingPlan.routeSelectedByUser = true;
      stored.updatedAt = new Date().toISOString();
      return stored;
    });
  }

  async createFolder(
    userId: string,
    name: string,
    parentId: string | null,
  ): Promise<ReportFolder> {
    return this.mutate(userId, (workspace) => {
      if (workspace.folders.length >= STORE_LIMITS.foldersPerUser) {
        throw new StoreQuotaError(
          `A workspace can contain at most ${STORE_LIMITS.foldersPerUser} folders.`,
        );
      }
      if (
        parentId &&
        !workspace.folders.some((folder) => folder.id === parentId)
      ) {
        throw new StoreQuotaError(
          "The selected parent folder does not exist in this workspace.",
        );
      }
      const folder: ReportFolder = {
        id: randomUUID(),
        name,
        parentId,
        createdAt: new Date().toISOString(),
      };
      workspace.folders.push(folder);
      return folder;
    });
  }

  /**
   * Delete a folder. `purge` permanently removes the results and report
   * documents filed in it; `release` moves them back to "All folders".
   * Child folders are re-parented to the root either way.
   */
  async deleteFolder(
    userId: string,
    id: string,
    mode: "purge" | "release",
  ): Promise<{ removedReports: number; removedDocuments: number } | null> {
    return this.mutate(userId, (workspace) => {
      if (!workspace.folders.some((folder) => folder.id === id)) return null;
      const timestamp = new Date().toISOString();
      let removedReports = 0;
      let removedDocuments = 0;
      if (mode === "purge") {
        const reportCount = workspace.reports.length;
        const documentCount = workspace.documents.length;
        workspace.reports = workspace.reports.filter(
          (item) => item.folderId !== id,
        );
        workspace.documents = workspace.documents.filter(
          (item) => item.folderId !== id,
        );
        removedReports = reportCount - workspace.reports.length;
        removedDocuments = documentCount - workspace.documents.length;
      } else {
        for (const item of [...workspace.reports, ...workspace.documents]) {
          if (item.folderId === id) {
            item.folderId = null;
            item.updatedAt = timestamp;
          }
        }
      }
      for (const folder of workspace.folders) {
        if (folder.parentId === id) folder.parentId = null;
      }
      workspace.folders = workspace.folders.filter(
        (folder) => folder.id !== id,
      );
      return { removedReports, removedDocuments };
    });
  }

  /**
   * Apply the duplicate-name policy inside an open mutation. Returns the parts
   * that were superseded (empty unless the caller confirmed an overwrite).
   */
  private applyPartNamePolicy(
    workspace: UserWorkspace,
    name: string,
    keepPartId: string | undefined,
    policy: PartNameConflictPolicy,
    timestamp: string,
  ): StoredPart[] {
    if (policy === "allow") return [];
    const colliding = visibleParts(workspace.parts).filter(
      (part) => part.id !== keepPartId && samePartName(part.name, name),
    );
    if (colliding.length === 0) return [];
    if (policy === "reject") throw new PartNameConflictError(colliding[0]);
    for (const part of colliding) {
      part.supersededAt = timestamp;
      part.replacedById = keepPartId ?? null;
      part.updatedAt = timestamp;
    }
    return colliding;
  }

  /**
   * Hide every visible part that carries `name`, except the one that took the
   * name over. Used once a confirmed overwrite has actually produced its
   * replacement (the analysis succeeded), so a failed run never hides the part
   * the user still relies on. Blobs are never touched: old results, drawings
   * and reports keep resolving to the superseded record's geometry.
   */
  async supersedePartsByName(
    userId: string,
    name: string,
    replacedById: string,
  ): Promise<StoredPart[]> {
    return this.mutate(userId, (workspace) => {
      const timestamp = new Date().toISOString();
      return this.applyPartNamePolicy(
        workspace,
        name,
        replacedById,
        "supersede",
        timestamp,
      );
    });
  }

  /**
   * Record an uploaded part. When the rolling log is full, the oldest part
   * that is not being analysed is evicted so uploads never fail on quota.
   */
  async savePart(
    userId: string,
    input: Omit<StoredPart, "id" | "createdAt" | "updatedAt">,
    options: PartNameOptions = {},
  ): Promise<StoredPart> {
    return this.mutate(userId, (workspace) => {
      const policy = options.onNameConflict ?? "allow";
      // Checked before the quota eviction below so a rejected duplicate never
      // costs the user an existing record.
      if (policy === "reject") {
        this.applyPartNamePolicy(
          workspace,
          input.name,
          undefined,
          "reject",
          "",
        );
      }
      if (workspace.parts.length >= STORE_LIMITS.partsPerUser) {
        const evictable = [...workspace.parts]
          .reverse()
          .find((item) => item.status !== "analyzing");
        if (!evictable) {
          throw new StoreQuotaError(
            `A workspace can contain at most ${STORE_LIMITS.partsPerUser} parts.`,
          );
        }
        workspace.parts = workspace.parts.filter(
          (item) => item.id !== evictable.id,
        );
      }
      const timestamp = new Date().toISOString();
      const part: StoredPart = {
        ...input,
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      workspace.parts.unshift(part);
      if (policy === "supersede") {
        this.applyPartNamePolicy(
          workspace,
          part.name,
          part.id,
          "supersede",
          timestamp,
        );
      }
      return part;
    });
  }

  async updatePart(
    userId: string,
    id: string,
    changes: Partial<
      Pick<
        StoredPart,
        | "name"
        // The CAD file of a part can be replaced before re-running its
        // analysis, which rewrites the file identity as well as its blobs.
        | "fileName"
        | "format"
        | "sizeBytes"
        | "status"
        | "reportId"
        | "zooProjectId"
        | "modelBlobKey"
        | "cadBlobKey"
      >
    >,
    options: PartNameOptions = {},
  ): Promise<StoredPart | null> {
    return this.mutate(userId, (workspace) => {
      const part = workspace.parts.find((item) => item.id === id);
      if (!part) return null;
      const timestamp = new Date().toISOString();
      // A rename only collides with OTHER visible parts: re-casing a part's own
      // name, or saving it unchanged, is never a conflict.
      if (changes.name !== undefined) {
        this.applyPartNamePolicy(
          workspace,
          changes.name,
          part.id,
          options.onNameConflict ?? "allow",
          timestamp,
        );
      }
      Object.assign(part, changes, { updatedAt: timestamp });
      return part;
    });
  }

  async deletePart(userId: string, id: string): Promise<boolean> {
    return this.mutate(userId, (workspace) => {
      const previousLength = workspace.parts.length;
      workspace.parts = workspace.parts.filter((item) => item.id !== id);
      return workspace.parts.length !== previousLength;
    });
  }

  async upsertMachine(
    userId: string,
    input: Omit<MachineProfile, "id" | "createdAt"> & { id?: string },
  ): Promise<MachineProfile> {
    return this.mutate(userId, (workspace) => {
      const existing = input.id
        ? workspace.machines.find((item) => item.id === input.id)
        : undefined;
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      if (workspace.machines.length >= STORE_LIMITS.machinesPerUser) {
        throw new StoreQuotaError(
          `A workspace can contain at most ${STORE_LIMITS.machinesPerUser} machines.`,
        );
      }
      const machine: MachineProfile = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      workspace.machines.push(machine);
      return machine;
    });
  }

  async deleteMachine(userId: string, id: string): Promise<boolean> {
    return this.mutate(userId, (workspace) => {
      const previousLength = workspace.machines.length;
      workspace.machines = workspace.machines.filter((item) => item.id !== id);
      return workspace.machines.length !== previousLength;
    });
  }
}

export type WorkspaceStorageDriverName = "json" | "postgres";

export function resolveDataDir(): string {
  return (
    process.env.QUOTEREADY_DATA_DIR ||
    process.env.QUOTE_READY_DATA_DIR ||
    path.join(process.cwd(), "data")
  );
}

function resolveDriverConfig(): {
  name: WorkspaceStorageDriverName;
  key: string;
} {
  const name = (
    process.env.QUOTEREADY_STORAGE_DRIVER || "json"
  ).toLowerCase() as WorkspaceStorageDriverName;
  if (name === "postgres") {
    const connectionString =
      process.env.QUOTEREADY_DATABASE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) {
      throw new StoreConfigurationError(
        "QUOTEREADY_STORAGE_DRIVER=postgres requires QUOTEREADY_DATABASE_URL (or DATABASE_URL).",
      );
    }
    return { name, key: `postgres:${connectionString}` };
  }
  if (name !== "json") {
    throw new StoreConfigurationError(
      `Unknown QUOTEREADY_STORAGE_DRIVER value: ${name}. Use "json" or "postgres".`,
    );
  }
  return { name: "json", key: `json:${resolveDataDir()}` };
}

const storeCache = new Map<string, WorkspaceStore>();

/**
 * Environment-driven store factory. Instances are cached per configuration so
 * concurrent callers share one driver (and its mutation serialization).
 */
export function getWorkspaceStore(): WorkspaceStore {
  const config = resolveDriverConfig();
  const cached = storeCache.get(config.key);
  if (cached) return cached;
  const driver: WorkspaceStoreDriver =
    config.name === "postgres"
      ? new PostgresWorkspaceDriver(config.key.slice("postgres:".length))
      : new JsonWorkspaceDriver(config.key.slice("json:".length));
  const store = new WorkspaceStore(driver);
  storeCache.set(config.key, store);
  return store;
}
