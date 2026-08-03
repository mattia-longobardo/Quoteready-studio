import { describe, expect, it } from "vitest";

import type { DrawingTable } from "@quoteredy/core/types";

import {
  balloonSvg,
  directions,
  featureControlFrame,
  frameSize,
  gdtSymbolOf,
  horizontalDimension,
  Occupancy,
} from "@/lib/drawing-annotations";
import {
  clipMesh,
  hatchOutline,
  insideOutline,
  meshFeatures,
  outerFace,
  prepareMesh,
  sectionOutline,
} from "@/lib/drawing-features";
import { drawingSheetHtml, SHEET_VIEW_AREA } from "@/lib/drawing-sheet";
import { buildDrawingViews } from "@/lib/drawing-views";
import { parseGltfMesh } from "@/lib/gltf-mesh";

import { BLOCK, SLOT, slottedBlock } from "./fixtures/slotted-block";

/** Corners of a 100 × 20 × 30 mm box, in the metres glTF uses. */
const CORNERS: [number, number, number][] = [
  [0, 0, 0],
  [0.1, 0, 0],
  [0.1, 0.02, 0],
  [0, 0.02, 0],
  [0, 0, 0.03],
  [0.1, 0, 0.03],
  [0.1, 0.02, 0.03],
  [0, 0.02, 0.03],
];

const FACES: [number, number, number][] = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];

/** Minimal non-indexed glTF of the box, matching Zoo's conversion output. */
function boxGltf(): Uint8Array {
  const values = new Float32Array(FACES.length * 9);
  FACES.forEach((face, index) => {
    face.forEach((corner, at) => {
      values.set(CORNERS[corner], index * 9 + at * 3);
    });
  });
  const buffer = Buffer.from(values.buffer);
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: FACES.length * 3,
        type: "VEC3",
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: buffer.byteLength }],
    buffers: [
      {
        byteLength: buffer.byteLength,
        uri: `data:application/octet-stream;base64,${buffer.toString("base64")}`,
      },
    ],
  };
  return new Uint8Array(Buffer.from(JSON.stringify(document), "utf8"));
}

function drawing(rows: number): DrawingTable {
  return {
    id: "0f2a9c31-4d0e-4f7a-9c1e-2b7d5a6e8f10",
    partId: "part-1",
    partName: "Bracket",
    fileName: "bracket.step",
    status: "ready",
    error: null,
    units: "mm",
    generalTolerance: "ISO 2768-m",
    datums: [{ label: "A", feature: "Base face", reason: "Largest planar" }],
    rows: Array.from({ length: rows }, (_, index) => ({
      id: `row-${index}`,
      feature: `Feature ${index + 1}`,
      nominal: "10.00",
      tolerance: "±0.10",
      datums: "A",
      kind: index % 2 === 0 ? "dimension" : "gdt",
      note: "",
    })),
    notes: ["Break sharp edges."],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("glTF mesh reader", () => {
  it("reads the triangles of an embedded model in millimetres", () => {
    const mesh = parseGltfMesh(boxGltf());
    expect(mesh).not.toBeNull();
    expect(mesh!.positions.length).toBe(FACES.length * 9);
    expect(mesh!.min).toEqual([0, 0, 0]);
    expect(mesh!.max[0]).toBeCloseTo(100, 3);
    expect(mesh!.max[1]).toBeCloseTo(20, 3);
    expect(mesh!.max[2]).toBeCloseTo(30, 3);
  });

  it("returns null for content that is not a glTF model", () => {
    expect(parseGltfMesh(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("technical drawing views", () => {
  it("projects four aligned views at a standard scale", () => {
    const mesh = parseGltfMesh(boxGltf())!;
    const graphics = buildDrawingViews(mesh, SHEET_VIEW_AREA);
    expect(graphics.scale.label).toBe("1:1");
    expect(graphics.views.map((view) => view.key)).toEqual([
      "front",
      "left",
      "top",
      "iso",
    ]);
    // Front and left views share the part height, front and top its length.
    expect(graphics.views[0].heightMm).toBeCloseTo(
      graphics.views[1].heightMm,
      3,
    );
    expect(graphics.views[0].widthMm).toBeCloseTo(graphics.views[2].widthMm, 3);
    expect(graphics.svg).toContain("FRONT VIEW");
    expect(graphics.svg).toContain("ISOMETRIC VIEW");
    // Overall dimensions state the true size, whatever the sheet scale is.
    expect(graphics.svg).toContain(">100.00<");
    expect(graphics.svg).toContain(">20.00<");
    expect(graphics.svg).toContain(">30.00<");
  });
});

describe("drawing sheet", () => {
  it("prints one A3 sheet with the views, tables and title block", () => {
    const mesh = parseGltfMesh(boxGltf())!;
    const graphics = buildDrawingViews(mesh, SHEET_VIEW_AREA);
    const html = drawingSheetHtml({
      drawing: drawing(6),
      viewsSvg: graphics.svg,
      scale: graphics.scale,
      viewsNote: "",
      partData: [{ label: "Mass", value: "139.5 g" }],
      material: "Aluminium 6061",
      drawnAt: new Date("2026-02-03T10:00:00.000Z"),
    });
    expect(html).toContain("size: A3 landscape");
    expect(html).toContain("Bracket");
    expect(html).toContain("ISO 2768-m");
    expect(html).toContain("1 / 1");
    expect(html).toContain("2026-02-03");
    expect(html).toContain("Mass");
    expect(html.match(/class="sheet"/g)?.length).toBe(1);
  });

  it("circles the row numbers that carry a balloon on the views", () => {
    const html = drawingSheetHtml({
      drawing: drawing(6),
      viewsSvg: "<svg></svg>",
      scale: { ratio: 1, label: "1:1" },
      viewsNote: "",
      partData: [],
      balloonedRows: [2, 4],
      material: "Aluminium 6061",
      drawnAt: new Date("2026-02-03T10:00:00.000Z"),
    });
    expect(html).toContain('<span class="balloon">2</span>');
    expect(html).toContain('<span class="balloon">4</span>');
    expect(html).not.toContain('<span class="balloon">1</span>');
    expect(html).toContain("circled = on the views");
  });

  it("continues long tolerance tables on further sheets", () => {
    const html = drawingSheetHtml({
      drawing: drawing(40),
      viewsSvg: "",
      scale: null,
      viewsNote: "No model.",
      partData: [],
      material: "",
      drawnAt: new Date("2026-02-03T10:00:00.000Z"),
    });
    expect(html.match(/class="sheet"/g)?.length).toBe(3);
    expect(html).toContain("1 / 3");
    expect(html).toContain("3 / 3");
    expect(html).toContain("No model.");
    // Every row is printed exactly once across the sheets.
    expect(html.match(/>Feature \d+</g)?.length).toBe(40);
  });
});

describe("mesh features", () => {
  it("finds the milled pockets of a slotted block and their array", () => {
    const features = meshFeatures(prepareMesh(slottedBlock()));
    expect(features.size).toEqual([100, 20, 30]);
    // The three slots, and nothing else: the outer faces are flush with the
    // envelope and the slot walls are not reachable straight on.
    expect(features.pockets).toHaveLength(SLOT.starts.length);
    const [first] = features.pockets;
    expect(first.depthAxis).toBe(1);
    expect(first.openingSign).toBe(1);
    expect(first.depthMm).toBeCloseTo(SLOT.depth, 3);
    expect(first.floor).toBeCloseTo(BLOCK.height - SLOT.depth, 3);
    expect(features.arrays).toHaveLength(1);
    expect(features.arrays[0].pockets).toHaveLength(3);
    expect(features.arrays[0].arrayAxis).toBe(0);
    expect(features.arrays[0].pitchMm).toBeCloseTo(SLOT.pitch, 3);
  });

  it("keeps the datum faces of a plain box out of the pocket list", () => {
    const features = meshFeatures(prepareMesh(parseGltfMesh(boxGltf())!));
    expect(features.pockets).toHaveLength(0);
    expect(features.arrays).toHaveLength(0);
    // Six planar faces, each axis-aligned in both directions.
    expect(features.faces).toHaveLength(6);
    expect(outerFace(features, 1, -1)?.offset).toBeCloseTo(0, 3);
  });
});

describe("section cutting", () => {
  const plane = { normal: [0, 0, 1] as [number, number, number], offset: 15 };

  it("keeps the half of the mesh behind the plane", () => {
    const clipped = clipMesh(slottedBlock(), plane);
    expect(clipped.positions.length).toBeGreaterThan(0);
    expect(clipped.max[2]).toBeCloseTo(15, 6);
    expect(clipped.min[2]).toBeCloseTo(0, 6);
    // Nothing in front of the plane survives the clip.
    for (let at = 2; at < clipped.positions.length; at += 3) {
      expect(clipped.positions[at]).toBeLessThanOrEqual(15 + 1e-9);
    }
  });

  it("outlines and hatches the cut surface", () => {
    const outline = sectionOutline(slottedBlock(), plane, [1, 0, 0], [0, 1, 0]);
    expect(outline.length).toBeGreaterThan(4);
    const xs = outline.flatMap((edge) => [edge.x0, edge.x1]);
    const ys = outline.flatMap((edge) => [edge.y0, edge.y1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(BLOCK.length, 6);
    expect(Math.max(...ys)).toBeCloseTo(BLOCK.height, 6);
    // Material below a slot, air inside it.
    expect(insideOutline(outline, SLOT.starts[0] + 3, 4)).toBe(true);
    expect(insideOutline(outline, SLOT.starts[0] + 3, 18)).toBe(false);
    const hatch = hatchOutline(outline, 2.2);
    expect(hatch.length).toBeGreaterThan(10);
    for (const stroke of hatch) {
      // Every hatch stroke runs at 45° and stays inside the material.
      const dx = stroke.x1 - stroke.x0;
      const dy = stroke.y1 - stroke.y0;
      expect(Math.abs(Math.abs(dx) - Math.abs(dy))).toBeLessThan(1e-6);
      expect(
        insideOutline(
          outline,
          (stroke.x0 + stroke.x1) / 2,
          (stroke.y0 + stroke.y1) / 2,
        ),
      ).toBe(true);
    }
  });
});

describe("annotation primitives", () => {
  it("reads the geometric characteristic out of a tolerance cell", () => {
    expect(gdtSymbolOf("perpendicularity 0.10")).toBe("perpendicularity");
    expect(gdtSymbolOf("flatness 0.05")).toBe("flatness");
    expect(gdtSymbolOf("position 0.20")).toBe("position");
    expect(gdtSymbolOf("parallelism 0.15")).toBe("parallelism");
    expect(gdtSymbolOf("±0.10")).toBeNull();
  });

  it("draws a feature control frame with one compartment per datum", () => {
    const spec = {
      symbol: "position" as const,
      tolerance: "Ø0.20",
      datums: ["A", "B", "C"],
    };
    const size = frameSize(spec);
    expect(size.width).toBeGreaterThan(20);
    const svg = featureControlFrame({ x: 10, y: 10, ...size }, spec);
    // Symbol, tolerance and three datum letters: four internal dividers.
    expect(svg.match(/stroke-width="0.25"/g)?.length).toBe(5);
    expect(svg).toContain(">Ø0.20<");
    expect(svg).toContain(">A<");
    expect(svg).toContain(">C<");
    // The symbol is drawn, never typed: no GD&T glyph is required from a font.
    expect(svg).toContain("<circle");
  });

  it("omits the leader when a balloon touches its frame", () => {
    const attached = balloonSvg({ x: 20, y: 20 }, { x: 23, y: 20 }, "7");
    expect(attached).not.toContain('r="0.55"');
    const remote = balloonSvg({ x: 20, y: 20 }, { x: 40, y: 30 }, "7");
    expect(remote).toContain('r="0.55"');
    expect(remote).toContain(">7<");
  });

  it("places callouts on the nearest free paper", () => {
    const space = new Occupancy({ x: 0, y: 0, width: 100, height: 100 });
    space.reserve({ x: 40, y: 40, width: 20, height: 20 });
    const size = { width: 8, height: 8 };
    const first = space.place(
      { x: 50, y: 50 },
      size,
      directions(-90),
      [10, 20],
    );
    expect(first).not.toBeNull();
    expect(space.free(first!)).toBe(true);
    space.reserve(first!);
    const second = space.place(
      { x: 50, y: 50 },
      size,
      directions(-90),
      [10, 20],
    );
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
    // Nothing fits in a fully reserved sheet.
    const full = new Occupancy({ x: 0, y: 0, width: 100, height: 100 });
    full.reserve({ x: 0, y: 0, width: 100, height: 100 });
    expect(full.place({ x: 50, y: 50 }, size, directions(0), [10])).toBeNull();
  });

  it("states a dimension value above its line with the true size", () => {
    const dimension = horizontalDimension(10, 40, 50, 42, "30.00");
    expect(dimension.svg).toContain(">30.00<");
    expect(dimension.anchor).toEqual({ x: 25, y: 42 });
    expect(dimension.rect.y).toBeLessThan(42);
    // Short dimensions turn their arrows outwards.
    const tight = horizontalDimension(10, 14, 50, 42, "4.00");
    expect(tight.svg).toContain("M5 42L19 42");
  });
});

describe("annotated views", () => {
  const annotations = {
    datums: [
      { label: "A", feature: "Largest planar base face" },
      { label: "B", feature: "Largest planar end face normal to length" },
      { label: "C", feature: "Largest planar side face normal to width" },
    ],
    rows: [
      {
        feature: "Overall length",
        nominal: "100.00",
        tolerance: "±0.30",
        datums: "B",
        kind: "dimension" as const,
      },
      {
        feature: "Overall width",
        nominal: "30.00",
        tolerance: "±0.20",
        datums: "C",
        kind: "dimension" as const,
      },
      {
        feature: "Overall height",
        nominal: "20.00",
        tolerance: "±0.20",
        datums: "A",
        kind: "dimension" as const,
      },
      {
        feature: "Datum A base face",
        nominal: "CAD nominal",
        tolerance: "flatness 0.05",
        datums: "",
        kind: "gdt" as const,
      },
      {
        feature: "Datum B end face",
        nominal: "90° basic",
        tolerance: "perpendicularity 0.10",
        datums: "A",
        kind: "gdt" as const,
      },
      {
        feature: "Slot opening sizes",
        nominal: "6.00",
        tolerance: "±0.05",
        datums: "A|B|C",
        kind: "dimension" as const,
      },
      {
        feature: "Slot centre planes",
        nominal: "CAD basic",
        tolerance: "position 0.15",
        datums: "A|B|C",
        kind: "gdt" as const,
      },
      {
        feature: "Slot walls",
        nominal: "90° basic",
        tolerance: "perpendicularity 0.08",
        datums: "A",
        kind: "gdt" as const,
      },
      {
        feature: "Opposite support face",
        nominal: "CAD basic",
        tolerance: "parallelism 0.12",
        datums: "A",
        kind: "gdt" as const,
      },
    ],
  };

  it("adds a hatched section view through the pockets", () => {
    const graphics = buildDrawingViews(slottedBlock(), SHEET_VIEW_AREA);
    expect(graphics.views.map((view) => view.key)).toEqual([
      "front",
      "left",
      "top",
      "iso",
      "section",
    ]);
    expect(graphics.svg).toContain("SECTION A-A");
    // The cutting-plane line carries the section letters on a donor view.
    expect(graphics.svg.match(/>A</g)?.length).toBe(2);
    const section = graphics.views.find((view) => view.key === "section")!;
    expect(section.widthMm).toBeCloseTo(BLOCK.length, 3);
    expect(section.heightMm).toBeCloseTo(BLOCK.height, 3);
  });

  it("dimensions the pocket array as well as the envelope", () => {
    const graphics = buildDrawingViews(slottedBlock(), SHEET_VIEW_AREA);
    // Envelope, each size once.
    expect(graphics.svg).toContain(">100.00<");
    expect(graphics.svg).toContain(">20.00<");
    expect(graphics.svg).toContain(">30.00<");
    // Opening size (once for the whole array), length, pitch and depth.
    expect(graphics.svg).toContain(">3× 6.00<");
    expect(graphics.svg).toContain(">14.00<");
    expect(graphics.svg).toContain(">2× 20.00<");
    expect(graphics.svg).toContain(">8.00<");
  });

  it("balloons the table rows and draws their datums and control frames", () => {
    const graphics = buildDrawingViews(
      slottedBlock(),
      SHEET_VIEW_AREA,
      annotations,
    );
    // Every row resolved to a feature of this part.
    expect(graphics.balloonedRows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Three datum indicators, each a filled triangle with a boxed letter.
    expect(graphics.svg.match(/>B</g)?.length).toBeGreaterThanOrEqual(2);
    for (const tolerance of ["0.05", "0.10", "0.15", "0.08", "0.12"]) {
      expect(graphics.svg).toContain(`>${tolerance}<`);
    }
    // Balloons: one circle of radius 4 per ballooned row.
    expect(graphics.svg.match(/r="4"/g)?.length).toBe(9);
  });

  it("leaves the views unannotated when the table is not supplied", () => {
    const graphics = buildDrawingViews(slottedBlock(), SHEET_VIEW_AREA);
    expect(graphics.balloonedRows).toEqual([]);
    expect(graphics.svg).not.toContain('r="4"');
  });
});
