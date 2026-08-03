import type { ResultAttachment, RfqMetadata } from "@quoteredy/core/types";

/**
 * Additional material attached to a result (drawings, documents, notes) is
 * folded into the RFQ context so re-running the analysis, the Zoo pricing agent
 * and the AI report all reason on it. The merge is deliberately text-based:
 * `RfqMetadata.notes` is already carried into every downstream prompt.
 */

/** Heading that separates the user's own notes from the attached context. */
export const ATTACHED_CONTEXT_HEADING =
  "Additional context attached by the user:";

/** Same bound `parseRfqMetadata` applies to the notes field. */
export const MAX_NOTES_LENGTH = 2_000;

const DRAWING_MEDIA_TYPE = /^(?:application\/pdf|image\/(?:png|jpeg))$/i;
const DRAWING_EXTENSION = /\.(?:pdf|png|jpe?g)$/i;

/** Whether an attachment counts as the supporting drawing of the RFQ. */
export function isDrawingAttachment(attachment: ResultAttachment): boolean {
  return (
    attachment.kind === "file" &&
    (DRAWING_MEDIA_TYPE.test(attachment.mediaType) ||
      DRAWING_EXTENSION.test(attachment.fileName))
  );
}

/** One context line per attachment, in the order the user added them. */
export function attachmentContextLines(
  attachments: readonly ResultAttachment[],
): string[] {
  const lines: string[] = [];
  for (const attachment of attachments) {
    const text = attachment.text.trim();
    if (attachment.kind === "note") {
      if (text) lines.push(`Note: ${text}`);
      continue;
    }
    const kind = isDrawingAttachment(attachment) ? "drawing" : "document";
    lines.push(
      `Attached ${kind} "${attachment.fileName}"${text ? ` — ${text}` : ""}`,
    );
  }
  return lines;
}

/**
 * Notes field for a run that includes the attached material. Any block a
 * previous re-run appended is replaced, so repeated re-runs never stack the
 * same context twice.
 */
export function notesWithAttachments(
  notes: string,
  attachments: readonly ResultAttachment[],
): string {
  const own = notes.split(ATTACHED_CONTEXT_HEADING)[0].trim();
  const lines = attachmentContextLines(attachments);
  if (lines.length === 0) return own.slice(0, MAX_NOTES_LENGTH);
  const block = [ATTACHED_CONTEXT_HEADING, ...lines.map((line) => `- ${line}`)]
    .join("\n")
    .trim();
  return (own ? `${own}\n\n${block}` : block).slice(0, MAX_NOTES_LENGTH);
}

/**
 * RFQ metadata for a re-run: the attached material becomes part of the notes,
 * and an attached drawing satisfies the "supporting drawing" readiness check.
 */
export function metadataWithAttachments(
  metadata: RfqMetadata,
  attachments: readonly ResultAttachment[],
): RfqMetadata {
  return {
    ...metadata,
    notes: notesWithAttachments(metadata.notes, attachments),
    hasDrawing: metadata.hasDrawing || attachments.some(isDrawingAttachment),
  };
}

interface RevisionLink {
  id: string;
  sourceResultId?: string | null;
}

interface PartLink {
  reportId: string | null;
}

/**
 * Ids of a result's re-run chain: the result itself plus every result that was
 * re-run from it, transitively. A re-run re-points the part at the newest
 * result, so an older revision finds its 3D part through the chain.
 */
export function resultRevisionIds(
  reports: readonly RevisionLink[],
  resultId: string,
): string[] {
  const ids = [resultId];
  for (let index = 0; index < ids.length; index += 1) {
    for (const report of reports) {
      if (report.sourceResultId === ids[index] && !ids.includes(report.id)) {
        ids.push(report.id);
      }
    }
  }
  return ids;
}

/** The part that currently holds the 3D file analysed for a result. */
export function findResultPart<Part extends PartLink>(
  parts: readonly Part[],
  reports: readonly RevisionLink[],
  resultId: string,
): Part | null {
  const ids = new Set(resultRevisionIds(reports, resultId));
  return parts.find((part) => part.reportId && ids.has(part.reportId)) ?? null;
}

/** Compact attachment digest for the AI report prompt. */
export function attachmentPromptSummary(
  attachments: readonly ResultAttachment[],
): Array<{ kind: string; fileName?: string; text: string }> {
  return attachments.map((attachment) =>
    attachment.kind === "note"
      ? { kind: "note", text: attachment.text }
      : {
          kind: isDrawingAttachment(attachment) ? "drawing" : "document",
          fileName: attachment.fileName,
          text: attachment.text,
        },
  );
}
