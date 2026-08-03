import type { StoredReport, UserSettings } from "@quoteredy/core/types";

import { readResponseText, RequestInputError } from "@/lib/request-security";
import { attachmentPromptSummary } from "@/lib/result-context";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 180_000;

export class ReportGenerationError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ReportGenerationError";
  }
}

function systemPrompt(): string {
  return [
    "You are a senior manufacturing engineer writing a formal engineering report for QuoteReady Studio.",
    "Return ONLY a complete standalone HTML5 document (<!doctype html> ... </html>). No markdown, no explanations before or after.",
    "Hard constraints for the document:",
    "- All CSS inline in a single <style> block; no external resources (no external fonts, images, scripts, stylesheets); no <script> tags.",
    "- Illustrations must be inline SVG you draw yourself: a dimensioned technical sketch of the part derived from the provided geometry (bounding estimate, centre of mass), a horizontal bar chart comparing route costs, and a process-flow diagram of the recommended route's operations.",
    "- A4 print-friendly layout (max-width ~186mm, sensible page-break rules, dark text on white).",
    "- Professional structure: cover header with title/date/status, executive summary, part & RFQ data table, measured geometry table, quote-readiness findings, route comparison table with EUR costs and lead times, detailed recommended route (operations, setup/cycle minutes, cost breakdown), manufacturing risks, open questions, assumptions, and a traceability appendix.",
    "- Every number must come from the provided data; never invent measurements or prices. Monetary values are EUR (indicative engineering estimates, not quotations) — state this clearly.",
    "- Display numbers rounded to at most two decimals; never print raw floating-point noise. Text inside SVG shapes must fit: shorten labels or enlarge the shape, never let text overflow or overlap connectors.",
    "- Where data is missing or null, show 'Not available' rather than guessing.",
    "- When 'attachedMaterial' is present, treat it as customer-supplied context: reference the attached drawings/documents by file name and fold their notes into the findings, assumptions and open questions.",
  ].join("\n");
}

/**
 * The analysis pipeline stores full-precision floats (e.g. cycleMinutes
 * 128.8607637554295); the model is told to reproduce numbers verbatim, so they
 * must be rounded before they reach the prompt or they end up typeset into
 * tables and SVG diagrams.
 */
export function roundNumbersDeep<T>(value: T): T {
  if (typeof value === "number") {
    return (Number.isFinite(value)
      ? Number(value.toFixed(2))
      : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => roundNumbersDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, roundNumbersDeep(item)]),
    ) as unknown as T;
  }
  return value;
}

function userPrompt(result: StoredReport, settings: UserSettings): string {
  const report = result.report;
  const attachments = attachmentPromptSummary(result.attachments ?? []);
  return [
    `Generate the detailed manufacturing report for "${result.title}".`,
    `Report generated at: ${new Date().toLocaleString("en-GB", { timeZone: settings.timezone })} (${settings.timezone}). Currency: EUR.`,
    "Analysis data (authoritative, JSON):",
    JSON.stringify(
      roundNumbersDeep({
        title: result.title,
        file: report.file,
        mode: report.mode,
        readiness: { score: report.score, status: report.status },
        summary: report.summary,
        rfq: report.metadata,
        // Extra material the user attached to the result. Files are referenced
        // by name only (their bytes are not sent); treat their captions and the
        // notes as authoritative customer-supplied context.
        attachedMaterial: attachments.length > 0 ? attachments : undefined,
        geometry: report.metrics,
        checks: report.checks,
        questions: report.questions,
        assumptions: report.assumptions,
        manufacturingPlan: report.manufacturingPlan,
        apiTrace: report.apiTrace,
      }),
    ),
  ].join("\n\n");
}

function extractHtml(content: string): string {
  let html = content.trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) html = fenced.trim();
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  if (!/^<!doctype html|^<html[\s>]/i.test(html)) {
    throw new ReportGenerationError(
      "The model did not return a valid HTML document. Try again or switch model in Settings.",
    );
  }
  return sanitizeHtml(html);
}

/** Defense-in-depth: the document is also rendered in a sandboxed iframe. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "blocked:");
}

export async function generateReportHtml(input: {
  result: StoredReport;
  settings: UserSettings;
  apiKey: string;
}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.settings.aiReports.model,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt(input.result, input.settings) },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReportGenerationError(
      error instanceof Error && error.name === "TimeoutError"
        ? "The report generation timed out. Try a faster model in Settings."
        : "OpenAI could not be reached.",
    );
  }

  const text = await readResponseText(response, MAX_RESPONSE_BYTES);
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  } = {};
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new ReportGenerationError("OpenAI returned an unreadable response.");
  }

  if (!response.ok) {
    const detail =
      payload.error?.message?.slice(0, 300) ?? `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new ReportGenerationError(
        "OpenAI rejected the API key. Update it in Settings.",
        409,
      );
    }
    if (response.status === 404) {
      throw new ReportGenerationError(
        `OpenAI does not recognise the model "${input.settings.aiReports.model}". Update it in Settings.`,
        409,
      );
    }
    throw new ReportGenerationError(`OpenAI request failed: ${detail}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ReportGenerationError("OpenAI returned an empty report.");
  }
  return extractHtml(content);
}

export function missingKeyError(): RequestInputError {
  return new RequestInputError(
    "Detailed reports need an OpenAI API key. Add one in Settings.",
    409,
  );
}
