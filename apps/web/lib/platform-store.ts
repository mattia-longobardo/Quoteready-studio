import type {
  AuditReport,
  DrawingTable,
  MachineProfile,
  ReportDocument,
  ResultAttachment,
  StoredPart,
  StoredReport,
  StoredUserSettings,
} from "@quoteredy/core/types";
import {
  getWorkspaceStore,
  type PartNameOptions,
  type SaveReportOptions,
} from "@quoteredy/storage";

export {
  PartNameConflictError,
  STORE_LIMITS,
  StoreQuotaError,
} from "@quoteredy/storage";

export function getWorkspace(userId: string) {
  return getWorkspaceStore().getWorkspace(userId);
}

export function saveReport(
  userId: string,
  report: AuditReport,
  options?: SaveReportOptions,
) {
  return getWorkspaceStore().saveReport(userId, report, options);
}

export function addResultAttachment(
  userId: string,
  reportId: string,
  input: Omit<ResultAttachment, "id" | "createdAt">,
) {
  return getWorkspaceStore().addResultAttachment(userId, reportId, input);
}

export function removeResultAttachment(
  userId: string,
  reportId: string,
  attachmentId: string,
) {
  return getWorkspaceStore().removeResultAttachment(
    userId,
    reportId,
    attachmentId,
  );
}

export function updateReport(
  userId: string,
  id: string,
  changes: Partial<
    Pick<
      StoredReport,
      "title" | "folderId" | "archivedAt" | "trashedAt" | "tags"
    >
  >,
) {
  return getWorkspaceStore().updateReport(userId, id, changes);
}

export function saveDocument(
  userId: string,
  input: Pick<
    ReportDocument,
    "resultId" | "name" | "title" | "html" | "model"
  > & {
    tags?: string[];
    status?: ReportDocument["status"];
  },
) {
  return getWorkspaceStore().saveDocument(userId, input);
}

export function getDocument(userId: string, id: string) {
  return getWorkspaceStore().getDocument(userId, id);
}

export function updateDocument(
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
) {
  return getWorkspaceStore().updateDocument(userId, id, changes);
}

export function saveDrawing(
  userId: string,
  input: Omit<DrawingTable, "id" | "createdAt" | "updatedAt">,
) {
  return getWorkspaceStore().saveDrawing(userId, input);
}

export function updateDrawing(
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
) {
  return getWorkspaceStore().updateDrawing(userId, id, changes);
}

export function deleteDrawing(userId: string, id: string) {
  return getWorkspaceStore().deleteDrawing(userId, id);
}

export function emptyTrash(
  userId: string,
  collection: "results" | "documents",
) {
  return getWorkspaceStore().emptyTrash(userId, collection);
}

export function getSettings(userId: string) {
  return getWorkspaceStore().getSettings(userId);
}

export function updateSettings(userId: string, settings: StoredUserSettings) {
  return getWorkspaceStore().updateSettings(userId, settings);
}

export function selectReportRoute(
  userId: string,
  reportId: string,
  routeId: string,
) {
  return getWorkspaceStore().selectReportRoute(userId, reportId, routeId);
}

export function createFolder(
  userId: string,
  name: string,
  parentId: string | null,
) {
  return getWorkspaceStore().createFolder(userId, name, parentId);
}

export function deleteFolder(
  userId: string,
  id: string,
  mode: "purge" | "release",
) {
  return getWorkspaceStore().deleteFolder(userId, id, mode);
}

export function savePart(
  userId: string,
  input: Omit<StoredPart, "id" | "createdAt" | "updatedAt">,
  options?: PartNameOptions,
) {
  return getWorkspaceStore().savePart(userId, input, options);
}

export function updatePart(
  userId: string,
  id: string,
  changes: Partial<
    Pick<
      StoredPart,
      | "name"
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
  options?: PartNameOptions,
) {
  return getWorkspaceStore().updatePart(userId, id, changes, options);
}

/** Hide the parts a confirmed overwrite replaced (see the store method). */
export function supersedePartsByName(
  userId: string,
  name: string,
  replacedById: string,
) {
  return getWorkspaceStore().supersedePartsByName(userId, name, replacedById);
}

export function deletePart(userId: string, id: string) {
  return getWorkspaceStore().deletePart(userId, id);
}

export function upsertMachine(
  userId: string,
  input: Omit<MachineProfile, "id" | "createdAt"> & { id?: string },
) {
  return getWorkspaceStore().upsertMachine(userId, input);
}

export function deleteMachine(userId: string, id: string) {
  return getWorkspaceStore().deleteMachine(userId, id);
}
