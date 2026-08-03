import { describe, expect, it } from "vitest";

import type { ResultAttachment, RfqMetadata } from "@quoteredy/core/types";
import {
  ATTACHED_CONTEXT_HEADING,
  attachmentContextLines,
  attachmentPromptSummary,
  findResultPart,
  isDrawingAttachment,
  MAX_NOTES_LENGTH,
  metadataWithAttachments,
  notesWithAttachments,
  resultRevisionIds,
} from "@/lib/result-context";

function attachment(overrides: Partial<ResultAttachment>): ResultAttachment {
  return {
    id: "attachment-1",
    kind: "file",
    text: "",
    fileName: "drawing.pdf",
    mediaType: "application/pdf",
    sizeBytes: 10,
    blobKey: "users/u/reports/r/attachments/x/drawing.pdf",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const metadata: RfqMetadata = {
  partName: "Bracket",
  process: "cnc_milling",
  material: "aluminum_6061",
  quantity: 10,
  units: "mm",
  tolerance: "ISO 2768-m",
  finish: "As Machined",
  notes: "Deburr all edges.",
  hasDrawing: false,
};

describe("attachment classification", () => {
  it("treats PDF, PNG and JPEG files as supporting drawings", () => {
    expect(isDrawingAttachment(attachment({}))).toBe(true);
    expect(
      isDrawingAttachment(
        attachment({ mediaType: "", fileName: "sketch.JPEG" }),
      ),
    ).toBe(true);
    expect(
      isDrawingAttachment(
        attachment({ mediaType: "image/png", fileName: "view.png" }),
      ),
    ).toBe(true);
  });

  it("never treats a note or a plain document as a drawing", () => {
    expect(
      isDrawingAttachment(
        attachment({ kind: "note", fileName: "", mediaType: "" }),
      ),
    ).toBe(false);
    expect(
      isDrawingAttachment(
        attachment({ mediaType: "text/plain", fileName: "spec.txt" }),
      ),
    ).toBe(false);
  });
});

describe("attachment context lines", () => {
  it("describes notes, drawings and documents in order", () => {
    expect(
      attachmentContextLines([
        attachment({
          kind: "note",
          text: "Thread M6 both holes",
          fileName: "",
        }),
        attachment({ id: "a2", text: "Rev B" }),
        attachment({
          id: "a3",
          fileName: "spec.txt",
          mediaType: "text/plain",
          text: "",
        }),
      ]),
    ).toEqual([
      "Note: Thread M6 both holes",
      'Attached drawing "drawing.pdf" — Rev B',
      'Attached document "spec.txt"',
    ]);
  });

  it("drops empty notes", () => {
    expect(
      attachmentContextLines([
        attachment({ kind: "note", text: "   ", fileName: "" }),
      ]),
    ).toEqual([]);
  });
});

describe("notes merging", () => {
  it("appends the attached context under a stable heading", () => {
    const merged = notesWithAttachments("Deburr all edges.", [
      attachment({ kind: "note", text: "Anodise black", fileName: "" }),
    ]);
    expect(merged).toBe(
      `Deburr all edges.\n\n${ATTACHED_CONTEXT_HEADING}\n- Note: Anodise black`,
    );
  });

  it("keeps the user's own notes when nothing is attached", () => {
    expect(notesWithAttachments("Deburr all edges.", [])).toBe(
      "Deburr all edges.",
    );
  });

  it("replaces the block of a previous re-run instead of stacking it", () => {
    const first = notesWithAttachments("Base note.", [
      attachment({ kind: "note", text: "One", fileName: "" }),
    ]);
    const second = notesWithAttachments(first, [
      attachment({ kind: "note", text: "One", fileName: "" }),
      attachment({ id: "a2", kind: "note", text: "Two", fileName: "" }),
    ]);
    expect(
      second.match(new RegExp(ATTACHED_CONTEXT_HEADING, "g")),
    ).toHaveLength(1);
    expect(second).toContain("- Note: One");
    expect(second).toContain("- Note: Two");
    expect(second.startsWith("Base note.")).toBe(true);
  });

  it("stays inside the RFQ notes size bound", () => {
    const merged = notesWithAttachments(
      "x".repeat(1_900),
      Array.from({ length: 20 }, (_item, index) =>
        attachment({
          id: `a${index}`,
          kind: "note",
          fileName: "",
          text: "y".repeat(300),
        }),
      ),
    );
    expect(merged.length).toBe(MAX_NOTES_LENGTH);
  });
});

describe("metadata for a re-run", () => {
  it("folds the attachments into the notes and satisfies the drawing check", () => {
    const merged = metadataWithAttachments(metadata, [attachment({})]);
    expect(merged.hasDrawing).toBe(true);
    expect(merged.notes).toContain('Attached drawing "drawing.pdf"');
    // Everything else is carried over untouched.
    expect({ ...merged, notes: "", hasDrawing: false }).toEqual({
      ...metadata,
      notes: "",
      hasDrawing: false,
    });
  });

  it("leaves the drawing check alone when only notes are attached", () => {
    const merged = metadataWithAttachments(metadata, [
      attachment({ kind: "note", text: "No drawing exists", fileName: "" }),
    ]);
    expect(merged.hasDrawing).toBe(false);
  });

  it("summarises the attachments for the report prompt", () => {
    expect(
      attachmentPromptSummary([
        attachment({ text: "Rev B" }),
        attachment({ id: "a2", kind: "note", text: "Tight fit", fileName: "" }),
      ]),
    ).toEqual([
      { kind: "drawing", fileName: "drawing.pdf", text: "Rev B" },
      { kind: "note", text: "Tight fit" },
    ]);
  });
});

describe("re-run chains", () => {
  const reports = [
    { id: "r1" },
    { id: "r2", sourceResultId: "r1" },
    { id: "r3", sourceResultId: "r2" },
    { id: "other" },
  ];

  it("collects a result and every revision re-run from it", () => {
    expect(resultRevisionIds(reports, "r1")).toEqual(["r1", "r2", "r3"]);
    expect(resultRevisionIds(reports, "r3")).toEqual(["r3"]);
  });

  it("finds the part through the chain after a re-run moved it forward", () => {
    const parts = [{ id: "p1", reportId: "r3" }];
    expect(findResultPart(parts, reports, "r1")?.id).toBe("p1");
    expect(findResultPart(parts, reports, "other")).toBeNull();
  });
});
