import { randomUUID } from "node:crypto";

import { runCopilotPrompt } from "@quoteredy/core/zoo-copilot";
import type {
  DrawingDatum,
  DrawingRow,
  DrawingTable,
  StoredPart,
} from "@quoteredy/core/types";

import { updateDrawing } from "@/lib/platform-store";

// The agent answers from the attached CAD plus the pre-measured geometry
// context, and is explicitly told not to model or render — so the budget is
// minutes, not the tens of minutes a full copilot inspection loop takes.
const DRAWING_TIMEOUT_MS = 5 * 60_000;
const DRAWING_ATTEMPTS = 2;
/** A drawing stuck in "generating" longer than this may be regenerated. */
export const DRAWING_GENERATION_STALE_MS = 15 * 60_000;
/** Chat turns are text-only (no CAD attach) and must stay interactive. */
export const DRAWING_CHAT_TIMEOUT_MS = 120_000;

const MAX_DATUMS = 6;
const MAX_ROWS = 40;
const MAX_NOTES = 10;
const MAX_TEXT = 200;

const inFlight = new Set<string>();

const DRAWING_JSON_SHAPE = JSON.stringify({
  units: "mm",
  general_tolerance: "ISO 2768-m",
  datums: [{ label: "A", feature: "…", reason: "…" }],
  rows: [
    {
      feature: "…",
      nominal: "…",
      tolerance: "…",
      datums: "A|B",
      kind: "dimension or gdt",
      note: "…",
    },
  ],
  notes: ["…"],
  reply: "…",
});

function drawingPrompt(
  part: StoredPart,
  generalTolerance: string,
  geometryContext: string[],
): string {
  return [
    `The project contains the imported CAD file "${part.fileName}".`,
    "You are preparing the inspection/drawing table for this part as a",
    "manufacturing engineer: choose the datum reference frame and the",
    "dimensional and geometric tolerances yourself.",
    ...geometryContext,
    generalTolerance
      ? `The customer's general tolerance note is "${generalTolerance}".`
      : "No general tolerance was supplied; assume ISO 2768-m as the baseline.",
    "IMPORTANT: do NOT create, edit or render any model and do NOT write any",
    "file. Base your answer on the provided context (one quick measurement of",
    "the attached CAD is allowed only if strictly necessary) and respond",
    "immediately with ONLY a JSON object (no markdown, no prose) of this",
    "shape:",
    DRAWING_JSON_SHAPE,
    'The "reply" field is a one-sentence summary of what you produced.',
    "Pick at most three datums (A, B, C) on real features of this part,",
    "cover the manufacturing-critical dimensions and geometric controls",
    "(flatness, position, perpendicularity, …), and keep every text field",
    "short. Use millimetres unless the geometry is clearly imperial.",
  ].join(" ");
}

/**
 * Prompt for the live drawing chat: the agent edits the current table
 * according to the user's request and answers with the same JSON contract.
 */
export function drawingChatPrompt(
  drawing: DrawingTable,
  message: string,
): string {
  return [
    "You are Zookeeper maintaining the inspection/drawing table of the part",
    `"${drawing.partName}" (CAD file "${drawing.fileName}") for QuoteReady Studio.`,
    "This is the current drawing table JSON:",
    JSON.stringify({
      units: drawing.units,
      general_tolerance: drawing.generalTolerance,
      datums: drawing.datums,
      rows: drawing.rows.map((row) => ({
        feature: row.feature,
        nominal: row.nominal,
        tolerance: row.tolerance,
        datums: row.datums,
        kind: row.kind,
        note: row.note,
      })),
      notes: drawing.notes,
    }),
    `The user asks: "${message}"`,
    "Apply the request to the table. Keep everything the user did not ask to",
    "change identical. Do NOT create, edit or render any model and do NOT",
    "write any file. Respond immediately with ONLY a JSON object (no",
    "markdown, no prose) of this shape:",
    DRAWING_JSON_SHAPE,
    'The "reply" field (max 2 sentences) tells the user what you changed, or',
    "why nothing was changed when the request cannot be applied.",
  ].join(" ");
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : fallback;
}

interface ParsedDrawing {
  units: string;
  generalTolerance: string;
  datums: DrawingDatum[];
  rows: DrawingRow[];
  notes: string[];
  /** Short agent-authored summary of the answer (chat feedback). */
  reply: string;
}

/** Extract and bound the agent's JSON drawing table from its text answer. */
export function parseDrawingResponse(text: string): ParsedDrawing {
  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) body = fenced.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The Zoo agent did not return a JSON drawing table.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error("The Zoo agent returned unparseable JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Zoo agent returned an invalid drawing table.");
  }
  const record = parsed as Record<string, unknown>;

  const datums: DrawingDatum[] = (
    Array.isArray(record.datums) ? record.datums : []
  )
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .slice(0, MAX_DATUMS)
    .map((item, index) => ({
      label: cleanText(item.label, String.fromCharCode(65 + index)).slice(0, 3),
      feature: cleanText(item.feature, "Unnamed feature"),
      reason: cleanText(item.reason),
    }));

  const rows: DrawingRow[] = (Array.isArray(record.rows) ? record.rows : [])
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .slice(0, MAX_ROWS)
    .map((item) => ({
      id: randomUUID(),
      feature: cleanText(item.feature, "Feature"),
      nominal: cleanText(item.nominal),
      tolerance: cleanText(item.tolerance),
      datums: cleanText(item.datums).slice(0, 20),
      kind: item.kind === "gdt" ? "gdt" : "dimension",
      note: cleanText(item.note),
    }));
  if (rows.length === 0) {
    throw new Error("The Zoo agent returned no tolerance rows.");
  }

  return {
    units: cleanText(record.units, "mm").slice(0, 10),
    generalTolerance: cleanText(record.general_tolerance),
    datums,
    rows,
    notes: (Array.isArray(record.notes) ? record.notes : [])
      .map((note) => cleanText(note))
      .filter(Boolean)
      .slice(0, MAX_NOTES),
    reply:
      typeof record.reply === "string" ? record.reply.trim().slice(0, 400) : "",
  };
}

/** Persistable slice of a parsed drawing (everything except the chat reply). */
export function drawingTableChanges(
  parsed: ParsedDrawing,
): Pick<
  DrawingTable,
  "units" | "generalTolerance" | "datums" | "rows" | "notes"
> {
  return {
    units: parsed.units,
    generalTolerance: parsed.generalTolerance,
    datums: parsed.datums,
    rows: parsed.rows,
    notes: parsed.notes,
  };
}

/**
 * Background half of the drawing-table flow: ask the Zoo agent to pick datums
 * and tolerances for the part, then persist the outcome. Never throws —
 * failures are written back as status "failed" so the UI leaves "generating".
 */
export async function generateDrawingTable(input: {
  userId: string;
  drawingId: string;
  part: StoredPart;
  generalTolerance: string;
  /** Pre-measured facts (metrics, material, KCL) that spare a tool loop. */
  geometryContext: string[];
  cadBytes: Uint8Array;
  token: string;
}): Promise<void> {
  const flightKey = `${input.userId}:${input.drawingId}`;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  try {
    let text = "";
    for (let attempt = 1; attempt <= DRAWING_ATTEMPTS; attempt += 1) {
      try {
        const result = await runCopilotPrompt({
          token: input.token,
          content: drawingPrompt(
            input.part,
            input.generalTolerance,
            input.geometryContext,
          ),
          projectName: `QuoteReady Studio — drawing ${input.part.name}`,
          currentFiles: { [input.part.fileName]: input.cadBytes },
          forcedTools: [],
          timeoutMs: DRAWING_TIMEOUT_MS,
        });
        text = result.text;
        break;
      } catch (error) {
        const transient =
          error instanceof Error &&
          /interrupt|reconnect|shutdown|closed without/i.test(error.message);
        if (!transient || attempt === DRAWING_ATTEMPTS) throw error;
        console.warn(
          `Drawing generation attempt ${attempt} for ${input.drawingId} hit a transient Zoo error, retrying:`,
          error.message,
        );
      }
    }
    const parsed = parseDrawingResponse(text);
    await updateDrawing(input.userId, input.drawingId, {
      status: "ready",
      error: null,
      ...drawingTableChanges(parsed),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
    console.warn(`Drawing generation failed for ${input.drawingId}:`, detail);
    await updateDrawing(input.userId, input.drawingId, {
      status: "failed",
      error: detail,
    }).catch(() => undefined);
  } finally {
    inFlight.delete(flightKey);
  }
}
