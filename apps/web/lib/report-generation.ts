import type { StoredReport, UserSettings } from "@quoteredy/core/types";

import { updateDocument } from "@/lib/platform-store";
import { generateReportHtml } from "@/lib/report-ai";

/** A document stuck in "generating" longer than this may be regenerated. */
export const DOCUMENT_GENERATION_STALE_MS = 10 * 60_000;

const inFlight = new Set<string>();

/**
 * Background half of the detailed-report flow: ask the AI for the HTML and
 * persist the outcome on the document record. Never throws — failures are
 * written back as status "failed" so the UI always leaves "generating",
 * even when the user navigates away mid-generation.
 */
export async function generateReportDocument(input: {
  userId: string;
  documentId: string;
  result: StoredReport;
  settings: UserSettings;
  apiKey: string;
}): Promise<void> {
  const flightKey = `${input.userId}:${input.documentId}`;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  try {
    const html = await generateReportHtml({
      result: input.result,
      settings: input.settings,
      apiKey: input.apiKey,
    });
    await updateDocument(input.userId, input.documentId, {
      html,
      status: "ready",
      error: null,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
    console.warn(
      `Report generation failed for document ${input.documentId}:`,
      detail,
    );
    await updateDocument(input.userId, input.documentId, {
      status: "failed",
      error: detail,
    }).catch(() => undefined);
  } finally {
    inFlight.delete(flightKey);
  }
}
