import { randomUUID } from "node:crypto";

import type { StoredPart } from "@quoteredy/core/types";
import { getBlobStore, sanitizeBlobFileName } from "@quoteredy/storage";

import type { UploadedFile } from "@/lib/multipart";

/**
 * Uploaded CAD/drawing archival is opt-in: without it the platform keeps the
 * historical behavior of analysing uploads in memory only.
 */
export function uploadsPersistenceEnabled(): boolean {
  return process.env.QUOTEREADY_PERSIST_UPLOADS === "true";
}

export function reportArtifactKey(
  userId: string,
  reportId: string,
  fileName: string,
): string {
  return [
    "users",
    sanitizeBlobFileName(userId),
    "reports",
    sanitizeBlobFileName(reportId),
    sanitizeBlobFileName(fileName),
  ].join("/");
}

function partCadBlobKey(
  userId: string,
  partId: string,
  fileName: string,
): string {
  return [
    "users",
    sanitizeBlobFileName(userId),
    "parts",
    sanitizeBlobFileName(partId),
    "source",
    sanitizeBlobFileName(fileName),
  ].join("/");
}

/**
 * Best-effort archive of a part's source CAD file so later Zoo work (drawing
 * tables) can re-read it. Returns the blob key, or null when persistence is
 * disabled or the write failed (never throws).
 */
export async function archivePartCad(
  userId: string,
  partId: string,
  cadFile: UploadedFile,
): Promise<string | null> {
  if (!uploadsPersistenceEnabled()) return null;
  try {
    const key = partCadBlobKey(userId, partId, cadFile.name);
    await getBlobStore().put(
      key,
      cadFile.bytes,
      cadFile.mediaType || "application/octet-stream",
    );
    return key;
  } catch (error) {
    console.warn(
      `Part CAD archive failed for part ${partId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Archive a CAD file the user attached to an existing part (a replacement of
 * the 3D part before re-running its analysis). Unlike {@link archivePartCad}
 * this is not opt-in and not best-effort: the re-run reads the file back from
 * the blob store, so a failed write must surface to the caller.
 */
export async function storePartCad(
  userId: string,
  partId: string,
  cadFile: UploadedFile,
): Promise<string> {
  const key = partCadBlobKey(userId, partId, cadFile.name);
  await getBlobStore().put(
    key,
    cadFile.bytes,
    cadFile.mediaType || "application/octet-stream",
  );
  return key;
}

/**
 * Blob key for a new result attachment. A random segment keeps re-uploads of
 * the same file name from overwriting each other, and lets a re-run share the
 * bytes of the attachments it carries onto the new result.
 */
function newResultAttachmentKey(
  userId: string,
  reportId: string,
  fileName: string,
): string {
  return [
    "users",
    sanitizeBlobFileName(userId),
    "reports",
    sanitizeBlobFileName(reportId),
    "attachments",
    randomUUID(),
    sanitizeBlobFileName(fileName),
  ].join("/");
}

/**
 * Store the bytes of material attached to a result. Attachments only exist to
 * be read back later, so this always writes (independently of the opt-in
 * upload archival) and propagates failures.
 */
export async function storeResultAttachment(
  userId: string,
  reportId: string,
  file: UploadedFile,
): Promise<string> {
  const key = newResultAttachmentKey(userId, reportId, file.name);
  await getBlobStore().put(
    key,
    file.bytes,
    file.mediaType || "application/octet-stream",
  );
  return key;
}

/** Locate the archived CAD bytes for a part, wherever they were stored. */
function resolvePartCadKey(userId: string, part: StoredPart): string | null {
  if (part.cadBlobKey) return part.cadBlobKey;
  if (part.reportId) {
    return reportArtifactKey(userId, part.reportId, part.fileName);
  }
  return null;
}

/** Read the archived CAD bytes for a part, or null when nothing is stored. */
export async function readPartCad(
  userId: string,
  part: StoredPart,
): Promise<Uint8Array | null> {
  const key = resolvePartCadKey(userId, part);
  if (!key) return null;
  try {
    const bytes = await getBlobStore().get(key);
    return bytes ? new Uint8Array(bytes) : null;
  } catch (error) {
    console.warn(
      `Part CAD read failed for part ${part.id}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Best-effort archive of the analysed source files next to the stored report.
 * Failures never break the analysis response; they are only logged.
 */
export async function archiveReportArtifacts(
  userId: string,
  reportId: string,
  cadFile: UploadedFile,
  drawing: UploadedFile | null,
): Promise<void> {
  if (!uploadsPersistenceEnabled()) return;
  try {
    const store = getBlobStore();
    await store.put(
      reportArtifactKey(userId, reportId, cadFile.name),
      cadFile.bytes,
      cadFile.mediaType || "application/octet-stream",
    );
    if (drawing) {
      await store.put(
        reportArtifactKey(userId, reportId, drawing.name),
        drawing.bytes,
        drawing.mediaType || "application/octet-stream",
      );
    }
  } catch (error) {
    console.warn(
      `Report artifact archive failed for report ${reportId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
