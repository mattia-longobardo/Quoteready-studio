import type {
  ReportDocument,
  ReportDocumentSummary,
} from "@quoteredy/core/types";

export function toSummary(document: ReportDocument): ReportDocumentSummary {
  const { html, ...rest } = document;
  return { ...rest, sizeBytes: Buffer.byteLength(html, "utf8") };
}
