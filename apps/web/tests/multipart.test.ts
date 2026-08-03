import { describe, expect, it } from "vitest";

import { MAX_MULTIPART_BYTES, parseAnalysisMultipart } from "@/lib/multipart";

describe("bounded multipart parser", () => {
  it("extracts one CAD file and bounded RFQ fields", async () => {
    const form = new FormData();
    form.set("partName", "Bracket");
    form.set("process", "cnc_milling");
    form.set(
      "cadFile",
      new Blob(["ISO-10303-21; HEADER; ENDSEC;"], { type: "application/step" }),
      "bracket.step",
    );
    const request = new Request(
      "https://quoteready.example/api/analyze?mode=zoo",
      {
        method: "POST",
        body: form,
      },
    );

    const parsed = await parseAnalysisMultipart(request);
    expect(parsed.fields).toMatchObject({
      partName: "Bracket",
      process: "cnc_milling",
    });
    expect(parsed.cadFile?.name).toBe("bracket.step");
    expect(parsed.cadFile?.bytes.toString("utf8")).toContain("ISO-10303-21");
    expect(parsed.drawing).toBeNull();
  });

  it("extracts an attachment upload: a note plus a supporting drawing", async () => {
    const form = new FormData();
    form.set("resultId", "result-1");
    form.set("note", "Thread M6 both holes");
    form.set(
      "drawing",
      new Blob(["%PDF-1.7 fake"], { type: "application/pdf" }),
      "rev-b.pdf",
    );
    const request = new Request(
      "https://quoteready.example/api/reports/attachments",
      { method: "POST", body: form },
    );

    const parsed = await parseAnalysisMultipart(request);
    expect(parsed.fields).toMatchObject({
      resultId: "result-1",
      note: "Thread M6 both holes",
    });
    expect(parsed.cadFile).toBeNull();
    expect(parsed.drawing?.name).toBe("rev-b.pdf");
    expect(parsed.drawing?.mediaType).toBe("application/pdf");
  });

  it("rejects a declared body above the total upload ceiling before parsing", async () => {
    const request = new Request(
      "https://quoteready.example/api/analyze?mode=zoo",
      {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_MULTIPART_BYTES + 1),
          "Content-Type": "multipart/form-data; boundary=bounded-test",
        },
        body: "--bounded-test--\r\n",
      },
    );
    await expect(parseAnalysisMultipart(request)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects duplicate metadata fields", async () => {
    const form = new FormData();
    form.append("partName", "First");
    form.append("partName", "Second");
    const request = new Request(
      "https://quoteready.example/api/analyze?mode=zoo",
      {
        method: "POST",
        body: form,
      },
    );
    await expect(parseAnalysisMultipart(request)).rejects.toThrow(
      /more than once/,
    );
  });
});
