import type {
  DrawingTable,
  MachineProfile,
  ReportDocument,
  ReportFolder,
  StoredPart,
  StoredReport,
  StoredUserSettings,
} from "@quoteredy/core/types";

export interface UserWorkspace {
  folders: ReportFolder[];
  machines: MachineProfile[];
  reports: StoredReport[];
  documents: ReportDocument[];
  parts: StoredPart[];
  drawings: DrawingTable[];
  settings: StoredUserSettings | null;
}

export const STORE_LIMITS = {
  foldersPerUser: 200,
  machinesPerUser: 100,
  reportsPerUser: 250,
  documentsPerUser: 250,
  partsPerUser: 250,
  drawingsPerUser: 100,
  documentHtmlMaxBytes: 500 * 1024,
  attachmentsPerResult: 20,
  attachmentTextMaxLength: 4_000,
  tagsPerItem: 10,
  tagMaxLength: 30,
  maximumBytes: 64 * 1024 * 1024,
} as const;

export class StoreQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreQuotaError";
  }
}

export class StoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConfigurationError";
  }
}

export function emptyWorkspace(): UserWorkspace {
  return {
    folders: [],
    machines: [],
    reports: [],
    documents: [],
    parts: [],
    drawings: [],
    settings: null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkspaceShape(value: unknown): UserWorkspace {
  if (
    !isRecord(value) ||
    !Array.isArray(value.folders) ||
    !Array.isArray(value.machines) ||
    !Array.isArray(value.reports)
  ) {
    throw new Error("The workspace store contains an invalid user record.");
  }
  // Fields introduced after the first release may be missing in stored data.
  const workspace = value as unknown as UserWorkspace;
  if (!Array.isArray(workspace.documents)) workspace.documents = [];
  if (!Array.isArray(workspace.parts)) workspace.parts = [];
  if (!Array.isArray(workspace.drawings)) workspace.drawings = [];
  for (const report of workspace.reports) {
    // Attachments were introduced after results shipped: records without them
    // stay untouched (readers use `attachments ?? []`), a corrupted value is
    // dropped rather than allowed to break the whole workspace load.
    if (
      report.attachments !== undefined &&
      !Array.isArray(report.attachments)
    ) {
      report.attachments = [];
    }
  }
  for (const document of workspace.documents) {
    if (document.folderId === undefined) document.folderId = null;
    // Documents predating asynchronous generation are complete by definition.
    if (document.status === undefined) document.status = "ready";
    if (document.error === undefined) document.error = null;
  }
  if (!isRecord(workspace.settings)) workspace.settings = null;
  return workspace;
}

/** Validate and normalize a user-supplied tag list. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new StoreQuotaError("Tags must be provided as a list.");
  }
  const tags = [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) =>
          tag
            .trim()
            .replace(/[^\p{L}\p{N} _.-]/gu, "")
            .slice(0, STORE_LIMITS.tagMaxLength),
        )
        .filter(Boolean),
    ),
  ];
  if (tags.length > STORE_LIMITS.tagsPerItem) {
    throw new StoreQuotaError(
      `An item can have at most ${STORE_LIMITS.tagsPerItem} tags.`,
    );
  }
  return tags;
}

export function assertWorkspaceQuotas(workspace: UserWorkspace): void {
  if (workspace.folders.length > STORE_LIMITS.foldersPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.foldersPerUser} folders.`,
    );
  }
  if (workspace.machines.length > STORE_LIMITS.machinesPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.machinesPerUser} machines.`,
    );
  }
  if (workspace.reports.length > STORE_LIMITS.reportsPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.reportsPerUser} reports.`,
    );
  }
  if (workspace.documents.length > STORE_LIMITS.documentsPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.documentsPerUser} report documents.`,
    );
  }
  if (workspace.parts.length > STORE_LIMITS.partsPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.partsPerUser} parts.`,
    );
  }
  if (workspace.drawings.length > STORE_LIMITS.drawingsPerUser) {
    throw new StoreQuotaError(
      `A workspace can contain at most ${STORE_LIMITS.drawingsPerUser} drawing tables.`,
    );
  }
}

export interface WorkspaceStoreDriver {
  /** Read a user's workspace, or null when the user has no data yet. */
  read(userId: string): Promise<UserWorkspace | null>;
  /**
   * Apply a mutation to a user's workspace under exclusive access and persist
   * the result atomically.
   */
  mutate<T>(
    userId: string,
    operation: (workspace: UserWorkspace) => T | Promise<T>,
  ): Promise<T>;
}
