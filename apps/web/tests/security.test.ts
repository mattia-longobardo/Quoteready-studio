import { describe, expect, it } from "vitest";

import {
  assertSameOrigin,
  enforceRateLimit,
  readJsonObject,
  RequestInputError,
  withSingleFlight,
} from "@/lib/request-security";
import {
  getCadFormat,
  isValidCadContent,
  isValidDrawingContent,
  parseRfqMetadata,
} from "@/lib/rfq";

describe("request boundary controls", () => {
  it("accepts same-origin mutations and rejects a foreign origin", () => {
    const valid = new Request("https://quoteready.example/api/reports", {
      method: "POST",
      headers: { Origin: "https://quoteready.example" },
    });
    expect(() => assertSameOrigin(valid)).not.toThrow();

    const foreign = new Request("https://quoteready.example/api/reports", {
      method: "POST",
      headers: { Origin: "https://other.example" },
    });
    expect(() => assertSameOrigin(foreign)).toThrow(RequestInputError);
  });

  it("rejects JSON that exceeds the byte budget", async () => {
    const request = new Request("https://quoteready.example/api/factory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "x".repeat(200) }),
    });
    await expect(readJsonObject(request, 64)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("requires application/json for JSON endpoints", async () => {
    const request = new Request("https://quoteready.example/api/factory", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    await expect(readJsonObject(request)).rejects.toMatchObject({
      status: 415,
    });
  });

  it("enforces request windows and one active operation per identity", async () => {
    const key = `test-${crypto.randomUUID()}`;
    expect(() => enforceRateLimit(key, 2, 60_000)).not.toThrow();
    expect(() => enforceRateLimit(key, 2, 60_000)).not.toThrow();
    expect(() => enforceRateLimit(key, 2, 60_000)).toThrow(RequestInputError);

    let release!: () => void;
    const first = withSingleFlight(
      key,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      withSingleFlight(key, async () => undefined),
    ).rejects.toMatchObject({ status: 409 });
    release();
    await first;
  });
});

describe("RFQ validation", () => {
  const valid = {
    partName: "BR-042",
    process: "unknown",
    material: "aluminum_6061",
    quantity: "25",
    units: "mm",
    tolerance: "±0.1 mm",
    finish: "Anodised",
    notes: "Pilot batch",
    sourceProjectId: "project-1",
    sourceProjectName: "Bracket",
  };

  it("preserves bounded Zoo project traceability", () => {
    const metadata = parseRfqMetadata(valid, true);
    expect(metadata.quantity).toBe(25);
    expect(metadata.sourceProject).toEqual({
      id: "project-1",
      name: "Bracket",
    });
  });

  it("accepts the My Factory target process", () => {
    expect(
      parseRfqMetadata({ ...valid, process: "my_factory" }, true).process,
    ).toBe("my_factory");
    expect(() =>
      parseRfqMetadata({ ...valid, process: "teleportation" }, true),
    ).toThrow(/supported target process/);
  });

  it("rejects unsupported fields and overlong notes", () => {
    expect(() => parseRfqMetadata({ ...valid, role: "admin" }, false)).toThrow(
      /Unsupported RFQ field/,
    );
    expect(() =>
      parseRfqMetadata({ ...valid, notes: "x".repeat(2_001) }, false),
    ).toThrow(/2000/);
  });

  it("validates file extensions and representative signatures", () => {
    const step = new TextEncoder().encode("ISO-10303-21; HEADER; ENDSEC;");
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(getCadFormat("part.STEP")).toBe("step");
    expect(getCadFormat("part.exe")).toBeNull();
    expect(isValidCadContent({ bytes: step, size: step.length }, "step")).toBe(
      true,
    );
    expect(isValidCadContent({ bytes: pdf, size: pdf.length }, "step")).toBe(
      false,
    );
    expect(isValidDrawingContent({ bytes: pdf, size: pdf.length })).toBe(true);
  });
});
