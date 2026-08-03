import { describe, expect, it } from "vitest";

import { buildAuditReport } from "@quoteredy/core/audit";
import type { GeometryMetrics, RfqMetadata } from "@quoteredy/core/types";

const completeMetadata: RfqMetadata = {
  partName: "BR-042",
  process: "cnc_milling",
  material: "aluminum_6061",
  quantity: 25,
  units: "mm",
  tolerance: "ISO 2768-m",
  finish: "Black anodised",
  notes: "Pilot batch",
  hasDrawing: true,
};

const metrics: GeometryMetrics = {
  volumeMm3: 18_420,
  surfaceAreaMm2: 14_862,
  massG: 49.734,
  centerOfMassMm: [42, 30, 6],
};

function report(
  metadata: RfqMetadata = completeMetadata,
  geometry: GeometryMetrics = metrics,
) {
  return buildAuditReport({
    mode: "zoo",
    file: { name: "bracket.step", format: "step", sizeBytes: 1024 },
    metadata,
    metrics: geometry,
    apiTrace: [],
  });
}

describe("QuoteReady Studio audit scoring", () => {
  it("marks a complete package ready without inventing questions", () => {
    const result = report();

    expect(result.score).toBe(100);
    expect(result.status).toBe("ready");
    expect(result.questions).toHaveLength(0);
  });

  it("blocks missing quote-critical metadata while keeping route suggestion non-blocking", () => {
    const result = report({
      ...completeMetadata,
      process: "unknown",
      material: "unknown",
      units: "unknown",
      quantity: null,
      tolerance: "",
      finish: "",
      hasDrawing: false,
    });

    expect(result.status).toBe("blocked");
    expect(result.score).toBe(30);
    expect(result.questions.map((item) => item.id)).toContain("ask-units");
    expect(result.questions.map((item) => item.id)).toContain("ask-material");
    // No target process is a normal flow: no warning, no deduction and no
    // RFQ question — the user picks a proposed route before quoting.
    expect(result.questions.map((item) => item.id)).not.toContain(
      "ask-process",
    );
    expect(result.checks.find((item) => item.id === "process")?.status).toBe(
      "pass",
    );
    expect(result.checks.find((item) => item.id === "process")?.deduction).toBe(
      0,
    );
  });

  it("blocks the report when Zoo cannot measure solid volume", () => {
    const result = report(completeMetadata, { ...metrics, volumeMm3: null });

    expect(result.status).toBe("blocked");
    expect(
      result.checks.find((item) => item.id === "cad-readable")?.status,
    ).toBe("fail");
  });

  it("never labels fixed demo metrics as Zoo evidence", () => {
    const result = buildAuditReport({
      mode: "demo",
      file: { name: "demo.step", format: "step", sizeBytes: 1024 },
      metadata: completeMetadata,
      metrics,
      apiTrace: [],
    });

    expect(
      result.checks.find((item) => item.id === "cad-readable")?.source,
    ).toBe("rule");
    expect(result.checks.find((item) => item.id === "mass")?.source).toBe(
      "rule",
    );
    expect(result.assumptions).toContain(
      "Demo geometry metrics are fixed sample values and were not returned by Zoo.",
    );
  });
});
