/**
 * Projects the part mesh into the views printed on the technical-drawing sheet
 * and annotates them. Everything is computed on the CPU (the runtime container
 * has no GPU/WebGL stack) and emitted as plain SVG in paper millimetres:
 * silhouette and feature edges with hidden-line removal, a planar section view
 * with hatching, ISO 129 dimensions of the envelope and of the measurable
 * features, ISO 5459 datum indicators, ISO 1101 feature control frames and the
 * ISO 6433 balloons that tie the views to the rows of the drawing table.
 */

import {
  balloonSvg,
  BALLOON_RADIUS,
  boundsOf,
  centreOf,
  cuttingPlane,
  datumBoxSize,
  datumIndicator,
  directions,
  edgePoint,
  frameSize,
  frameWithLeader,
  gdtSymbolOf,
  horizontalDimension,
  inflate,
  Occupancy,
  round,
  segment,
  verticalDimension,
  type DimensionResult,
  type FrameSpec,
  type Point,
  type Rect,
} from "@/lib/drawing-annotations";
import {
  clipMesh,
  cross,
  crossAxes,
  dot,
  hatchOutline,
  insideOutline,
  meshFeatures,
  prepareMesh,
  sectionOutline,
  type Axis,
  type CutPlane,
  type MeshFeatures,
  type PocketFeature,
  type PreparedMesh,
  type Segment2,
} from "@/lib/drawing-features";
import type { TriangleMesh, Vec3 } from "@/lib/gltf-mesh";

export interface DrawingScale {
  /** Paper millimetres per part millimetre. */
  ratio: number;
  /** ISO 5455 label, e.g. "1:2". */
  label: string;
}

interface ProjectedView {
  key: string;
  label: string;
  /** Part extents along the view's screen axes, in millimetres. */
  widthMm: number;
  heightMm: number;
}

export interface DrawingViewport {
  widthMm: number;
  heightMm: number;
}

/** Row of the drawing table, as far as the annotations are concerned. */
interface AnnotationRow {
  feature: string;
  nominal: string;
  tolerance: string;
  datums: string;
  kind: "dimension" | "gdt";
}

interface AnnotationDatum {
  label: string;
  feature: string;
}

/** The table the balloons, datum letters and control frames come from. */
export interface DrawingAnnotations {
  datums: AnnotationDatum[];
  rows: AnnotationRow[];
}

interface DrawingGraphics {
  scale: DrawingScale;
  /** One SVG holding the whole first-angle arrangement, in paper mm. */
  svg: string;
  views: ProjectedView[];
  /** Free paper under the views: room for the part-data box, if any. */
  bottomFreeMm: number;
  /** Table rows that could be tied to a feature on the views. */
  balloonedRows: number[];
}

/** Which overall dimensions a view carries; each size is stated once. */
type DimensionAxis = "width" | "height";

interface ViewDefinition {
  key: string;
  label: string;
  /** Screen right, screen up and toward-the-viewer axes of the projection. */
  u: Vec3;
  v: Vec3;
  w: Vec3;
  /** Orthographic views also show the hidden edges, dashed as per ISO 128. */
  hiddenEdges: boolean;
  dimensions: DimensionAxis[];
  column: number;
  row: number;
  /** Set on a section view: the material in front of the plane is removed. */
  cut?: { plane: CutPlane; letter: string };
}

/** ISO 5455 preferred scales, largest first. */
const STANDARD_SCALES: DrawingScale[] = [
  { ratio: 50, label: "50:1" },
  { ratio: 20, label: "20:1" },
  { ratio: 10, label: "10:1" },
  { ratio: 5, label: "5:1" },
  { ratio: 2, label: "2:1" },
  { ratio: 1, label: "1:1" },
  { ratio: 1 / 2, label: "1:2" },
  { ratio: 1 / 5, label: "1:5" },
  { ratio: 1 / 10, label: "1:10" },
  { ratio: 1 / 20, label: "1:20" },
  { ratio: 1 / 50, label: "1:50" },
  { ratio: 1 / 100, label: "1:100" },
  { ratio: 1 / 200, label: "1:200" },
  { ratio: 1 / 500, label: "1:500" },
  { ratio: 1 / 1000, label: "1:1000" },
];

/** Tessellation edges flatter than this are internal, not part features. */
const FEATURE_ANGLE_COS = Math.cos((22 * Math.PI) / 180);
/** Paper millimetres between two hidden-line-removal samples along an edge. */
const SAMPLE_STEP_MM = 0.4;
const MIN_SAMPLES = 4;
const MAX_SAMPLES = 160;
/** Paper reserved around the projection block, in millimetres. */
const PAD_TOP = 15;
const PAD_LEFT = 16;
const PAD_RIGHT = 6;
const PAD_BOTTOM = 4;
/** Gaps between aligned views, and the caption strip under each row. */
const COLUMN_GAP = 15;
const ROW_GAP = 26;
const CAPTION_HEIGHT = 7;
/** Paper pitch of the section hatching, in millimetres. */
const HATCH_PITCH = 2.2;

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

// First-angle projection (ISO 128): the view from the left is placed on the
// right of the front view and the view from above below it, so the layout the
// sheet uses is front / left · top · section / isometric.
const ISO_W = normalize([1, 1, 1]);
const ISO_U = normalize(cross([0, 1, 0], ISO_W));

function baseViews(): ViewDefinition[] {
  return [
    {
      key: "front",
      label: "Front view",
      u: [1, 0, 0],
      v: [0, 1, 0],
      w: [0, 0, 1],
      hiddenEdges: true,
      dimensions: ["width", "height"],
      column: 0,
      row: 0,
    },
    {
      key: "left",
      label: "View from the left",
      u: [0, 0, 1],
      v: [0, 1, 0],
      w: [-1, 0, 0],
      hiddenEdges: true,
      dimensions: [],
      column: 1,
      row: 0,
    },
    {
      key: "top",
      label: "View from above",
      u: [1, 0, 0],
      v: [0, 0, -1],
      w: [0, 1, 0],
      hiddenEdges: true,
      dimensions: ["height"],
      column: 0,
      row: 1,
    },
    {
      key: "iso",
      label: "Isometric view",
      u: ISO_U,
      v: cross(ISO_W, ISO_U),
      w: ISO_W,
      hiddenEdges: false,
      dimensions: [],
      column: 1,
      row: 1,
    },
  ];
}

interface Projection {
  /** Screen x, screen y and depth (larger is nearer) per vertex. */
  points: Float64Array;
  front: Uint8Array;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

function project(mesh: PreparedMesh, view: ViewDefinition): Projection {
  const count = mesh.vertices.length / 3;
  const points = new Float64Array(count * 3);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const x = mesh.vertices[index * 3];
    const y = mesh.vertices[index * 3 + 1];
    const z = mesh.vertices[index * 3 + 2];
    const u = x * view.u[0] + y * view.u[1] + z * view.u[2];
    const v = x * view.v[0] + y * view.v[1] + z * view.v[2];
    points[index * 3] = u;
    points[index * 3 + 1] = v;
    points[index * 3 + 2] = x * view.w[0] + y * view.w[1] + z * view.w[2];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const faceCount = mesh.faces.length / 3;
  const front = new Uint8Array(faceCount);
  for (let face = 0; face < faceCount; face += 1) {
    const dotted =
      mesh.normals[face * 3] * view.w[0] +
      mesh.normals[face * 3 + 1] * view.w[1] +
      mesh.normals[face * 3 + 2] * view.w[2];
    front[face] = dotted > 0 ? 1 : 0;
  }
  return { points, front, minU, maxU, minV, maxV };
}

/**
 * Uniform bucket grid over the front-facing triangles of a projection: the
 * hidden-line pass asks it, for a point on an edge, whether some nearer facet
 * covers it.
 */
class DepthGrid {
  private readonly cells: number[][];
  private readonly columns: number;
  private readonly rows: number;
  private readonly cellU: number;
  private readonly cellV: number;

  constructor(
    private readonly mesh: PreparedMesh,
    private readonly projection: Projection,
    private readonly epsilon: number,
  ) {
    const faceCount = mesh.faces.length / 3;
    const side = Math.min(256, Math.max(8, Math.ceil(Math.sqrt(faceCount))));
    this.columns = side;
    this.rows = side;
    this.cellU = (projection.maxU - projection.minU) / side || 1;
    this.cellV = (projection.maxV - projection.minV) / side || 1;
    this.cells = Array.from({ length: side * side }, () => []);
    for (let face = 0; face < faceCount; face += 1) {
      if (!projection.front[face]) continue;
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (let corner = 0; corner < 3; corner += 1) {
        const at = mesh.faces[face * 3 + corner] * 3;
        const u = projection.points[at];
        const v = projection.points[at + 1];
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const startColumn = this.column(minU);
      const endColumn = this.column(maxU);
      const startRow = this.row(minV);
      const endRow = this.row(maxV);
      for (let row = startRow; row <= endRow; row += 1) {
        for (let column = startColumn; column <= endColumn; column += 1) {
          this.cells[row * this.columns + column].push(face);
        }
      }
    }
  }

  private column(u: number): number {
    const index = Math.floor((u - this.projection.minU) / this.cellU);
    return Math.min(this.columns - 1, Math.max(0, index));
  }

  private row(v: number): number {
    const index = Math.floor((v - this.projection.minV) / this.cellV);
    return Math.min(this.rows - 1, Math.max(0, index));
  }

  /** True when a front-facing facet covers (u, v) nearer than `depth`. */
  covers(u: number, v: number, depth: number): boolean {
    const cell = this.cells[this.row(v) * this.columns + this.column(u)];
    for (const face of cell) {
      const a = this.mesh.faces[face * 3] * 3;
      const b = this.mesh.faces[face * 3 + 1] * 3;
      const c = this.mesh.faces[face * 3 + 2] * 3;
      const points = this.projection.points;
      const ux = points[a];
      const uy = points[a + 1];
      const vx = points[b] - ux;
      const vy = points[b + 1] - uy;
      const wx = points[c] - ux;
      const wy = points[c + 1] - uy;
      const area = vx * wy - vy * wx;
      if (Math.abs(area) < 1e-12) continue;
      const px = u - ux;
      const py = v - uy;
      const beta = (px * wy - py * wx) / area;
      const gamma = (vx * py - vy * px) / area;
      const alpha = 1 - beta - gamma;
      if (alpha < 0 || beta < 0 || gamma < 0) continue;
      const covering =
        alpha * points[a + 2] + beta * points[b + 2] + gamma * points[c + 2];
      if (covering > depth + this.epsilon) return true;
    }
    return false;
  }
}

interface EdgeRuns {
  visible: string[];
  hidden: string[];
}

/** Split every drawn edge into visible and hidden runs, in paper millimetres. */
function traceEdges(
  mesh: PreparedMesh,
  projection: Projection,
  view: ViewDefinition,
  toPaper: (u: number, v: number) => [number, number],
  /** Extra occluder: the cut surface of a section view closes the solid. */
  occluder?: (u: number, v: number, depth: number) => boolean,
): EdgeRuns {
  const epsilon = mesh.diagonal * 1e-3;
  const grid = new DepthGrid(mesh, projection, epsilon);
  const visible: string[] = [];
  const hidden: string[] = [];
  // Dense tessellations are sampled more coarsely so the export stays fast:
  // the extra precision is invisible once the sheet is printed anyway.
  const sampleStep =
    SAMPLE_STEP_MM * Math.min(6, Math.max(1, mesh.faces.length / 3 / 20_000));
  const covered = (u: number, v: number, depth: number): boolean =>
    grid.covers(u, v, depth) || (occluder ? occluder(u, v, depth) : false);

  for (const edge of mesh.edges) {
    const frontA = projection.front[edge.faceA] === 1;
    const frontB = edge.faceB < 0 ? frontA : projection.front[edge.faceB] === 1;
    let draw = edge.faceB < 0 || frontA !== frontB;
    if (!draw) {
      const dotted =
        mesh.normals[edge.faceA * 3] * mesh.normals[edge.faceB * 3] +
        mesh.normals[edge.faceA * 3 + 1] * mesh.normals[edge.faceB * 3 + 1] +
        mesh.normals[edge.faceA * 3 + 2] * mesh.normals[edge.faceB * 3 + 2];
      draw = dotted < FEATURE_ANGLE_COS;
    }
    if (!draw) continue;

    const a = edge.a * 3;
    const b = edge.b * 3;
    const u0 = projection.points[a];
    const v0 = projection.points[a + 1];
    const d0 = projection.points[a + 2];
    const u1 = projection.points[b];
    const v1 = projection.points[b + 1];
    const d1 = projection.points[b + 2];
    const [px0, py0] = toPaper(u0, v0);
    const [px1, py1] = toPaper(u1, v1);

    // An edge whose two facets both point away is inside the silhouette of a
    // closed solid, so it is hidden without any sampling.
    if (!frontA && !frontB) {
      if (view.hiddenEdges) hidden.push(segment(px0, py0, px1, py1));
      continue;
    }

    const paperLength = Math.hypot(px1 - px0, py1 - py0);
    const samples = Math.min(
      MAX_SAMPLES,
      Math.max(MIN_SAMPLES, Math.ceil(paperLength / sampleStep)),
    );
    let runStart = 0;
    let runVisible: boolean | null = null;
    const flush = (from: number, to: number, isVisible: boolean): void => {
      if (!isVisible && !view.hiddenEdges) return;
      const target = isVisible ? visible : hidden;
      target.push(
        segment(
          px0 + (px1 - px0) * from,
          py0 + (py1 - py0) * from,
          px0 + (px1 - px0) * to,
          py0 + (py1 - py0) * to,
        ),
      );
    };
    for (let sample = 0; sample < samples; sample += 1) {
      const t = (sample + 0.5) / samples;
      const isVisible = !covered(
        u0 + (u1 - u0) * t,
        v0 + (v1 - v0) * t,
        d0 + (d1 - d0) * t,
      );
      if (runVisible === null) {
        runVisible = isVisible;
      } else if (isVisible !== runVisible) {
        flush(runStart, sample / samples, runVisible);
        runStart = sample / samples;
        runVisible = isVisible;
      }
    }
    if (runVisible !== null) flush(runStart, 1, runVisible);
  }
  return { visible, hidden };
}

function caption(text: string, centerX: number, y: number): string {
  return `<text x="${round(centerX)}" y="${round(y)}" fill="#5a6b61" font-size="2.9" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" letter-spacing="0.15">${text.toUpperCase()}</text>`;
}

function extents(projection: Projection): { width: number; height: number } {
  return {
    width: Math.max(projection.maxU - projection.minU, 1e-6),
    height: Math.max(projection.maxV - projection.minV, 1e-6),
  };
}

interface Placement {
  view: ViewDefinition;
  mesh: PreparedMesh;
  projection: Projection;
  size: { width: number; height: number };
  /** Paper box of the projection itself. */
  box: Rect;
  /** Paper box of the whole grid cell the view sits in. */
  cell: Rect;
  toPaper: (u: number, v: number) => [number, number];
  paperOf: (point: Vec3) => Point;
  /** Part axis (and direction) the view's u, v and w axes follow, if aligned. */
  uAxis: Axis | null;
  vAxis: Axis | null;
  wAxis: Axis | null;
  uSign: 1 | -1;
  vSign: 1 | -1;
  wSign: 1 | -1;
}

interface Layout {
  width: number;
  height: number;
  columns: number[];
  rows: number[];
}

interface Slot {
  view: ViewDefinition;
  mesh: PreparedMesh;
  projection: Projection;
  size: { width: number; height: number };
}

/** Paper footprint of the arrangement at a given scale. */
function layoutAt(slots: Slot[], ratio: number): Layout {
  const columnCount = Math.max(...slots.map((slot) => slot.view.column)) + 1;
  const rowCount = Math.max(...slots.map((slot) => slot.view.row)) + 1;
  const columns = Array.from({ length: columnCount }, (_, column) =>
    slots
      .filter((slot) => slot.view.column === column)
      .reduce((max, slot) => Math.max(max, slot.size.width * ratio), 0),
  );
  const rows = Array.from({ length: rowCount }, (_, row) =>
    slots
      .filter((slot) => slot.view.row === row)
      .reduce((max, slot) => Math.max(max, slot.size.height * ratio), 0),
  );
  return {
    width:
      PAD_LEFT +
      columns.reduce((sum, width) => sum + width, 0) +
      COLUMN_GAP * (columnCount - 1) +
      PAD_RIGHT,
    height:
      PAD_TOP +
      rows.reduce((sum, height) => sum + height + CAPTION_HEIGHT, 0) +
      ROW_GAP * (rowCount - 1) +
      PAD_BOTTOM,
    columns,
    rows,
  };
}

/** Largest ISO scale at which the whole arrangement still fits the sheet. */
function chooseScale(slots: Slot[], area: DrawingViewport): DrawingScale {
  return (
    STANDARD_SCALES.find((scale) => {
      const layout = layoutAt(slots, scale.ratio);
      return layout.width <= area.widthMm && layout.height <= area.heightMm;
    }) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1]
  );
}

function axisOf(vector: Vec3): { axis: Axis | null; sign: 1 | -1 } {
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(vector[axis]) > 0.999) {
      return { axis: axis as Axis, sign: vector[axis] > 0 ? 1 : -1 };
    }
  }
  return { axis: null, sign: 1 };
}

/* --------------------------------------------------------------- section */

/**
 * Cutting plane that opens up the internal features: it runs along the array of
 * the deepest pockets, so the section shows their depth. Returns null when the
 * part has no pocket worth sectioning.
 */
function chooseCut(
  features: MeshFeatures,
): { plane: CutPlane; letter: string; axis: Axis } | null {
  const array = features.arrays.find((item) => item.pockets.length >= 2);
  const pockets = array ? array.pockets : features.pockets.slice(0, 1);
  if (pockets.length === 0) return null;
  const deepest = pockets.reduce((best, pocket) =>
    pocket.depthMm > best.depthMm ? pocket : best,
  );
  if (deepest.depthMm < 1) return null;
  const depthAxis = deepest.depthAxis;
  const [p, q] = crossAxes(depthAxis);
  // Cut across the narrow side of the pocket so the section runs along the
  // pocket array and reveals every one of them.
  const arrayAxis =
    array?.arrayAxis ??
    (deepest.max[p] - deepest.min[p] >= deepest.max[q] - deepest.min[q]
      ? p
      : q);
  const axis = ([p, q] as Axis[]).find((value) => value !== arrayAxis) ?? q;
  let offset = (deepest.min[axis] + deepest.max[axis]) / 2;
  // Keep the plane clear of the coplanar faces of the part: cutting exactly
  // along a face leaves gaps in the outline of the cut surface.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const conflict = features.faces.some(
      (face) =>
        face.axis === axis && Math.abs(face.sign * face.offset - offset) < 0.2,
    );
    if (!conflict) break;
    offset += 0.31;
  }
  if (
    offset <= features.min[axis] + 0.5 ||
    offset >= features.max[axis] - 0.5
  ) {
    return null;
  }
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = 1;
  return { plane: { normal, offset }, letter: "A", axis };
}

/** View frame of a section: upright when the cut normal allows it. */
function sectionFrame(axis: Axis): { u: Vec3; v: Vec3; w: Vec3 } {
  const w: Vec3 = [0, 0, 0];
  w[axis] = 1;
  const v: Vec3 = axis === 1 ? [0, 0, -1] : [0, 1, 0];
  return { u: cross(v, w), v, w };
}

/* ----------------------------------------------------------- annotations */

interface Target {
  at: Point;
  /** Where callouts for this target should preferably sit, in SVG degrees. */
  preferDeg: number;
  /** View box the leader is allowed to cross. */
  view: Rect;
}

interface DatumPlacement {
  label: string;
  axis: Axis;
  sign: 1 | -1;
}

const DATUM_FALLBACK: [Axis, 1 | -1][] = [
  [1, -1],
  [0, 1],
  [2, -1],
];

/** Which face of the part each datum letter sits on, read from its wording. */
function datumPlacements(
  features: MeshFeatures,
  datums: AnnotationDatum[],
): DatumPlacement[] {
  const larger = (axis: Axis): 1 | -1 => {
    const area = (sign: 1 | -1): number =>
      features.faces
        .filter((face) => face.axis === axis && face.sign === sign)
        .reduce((max, face) => Math.max(max, face.areaMm2), 0);
    return area(1) >= area(-1) ? 1 : -1;
  };
  const used = new Set<string>();
  return datums.slice(0, 3).map((datum, index) => {
    const text = datum.feature.toLowerCase();
    let axis: Axis;
    let sign: 1 | -1;
    if (/base|bottom|underside|seat|mounting/.test(text)) {
      [axis, sign] = [1, -1];
    } else if (/top|upper/.test(text)) {
      [axis, sign] = [1, 1];
    } else if (/end|length|longitudinal|front|back/.test(text)) {
      axis = 0;
      sign = larger(0);
    } else if (/side|lateral|width|flank/.test(text)) {
      axis = 2;
      sign = larger(2);
    } else {
      [axis, sign] = DATUM_FALLBACK[index] ?? DATUM_FALLBACK[0];
    }
    // Two datums never share a face: fall back to the next free one.
    if (used.has(`${axis}${sign}`)) {
      const free = DATUM_FALLBACK.find(
        (candidate) => !used.has(`${candidate[0]}${candidate[1]}`),
      );
      if (free) [axis, sign] = free;
    }
    used.add(`${axis}${sign}`);
    return { label: datum.label, axis, sign };
  });
}

/** Numeric value carried by a tolerance cell, e.g. "position 0.20" → "0.20". */
function toleranceValue(row: AnnotationRow): string {
  const match = row.tolerance.match(/[0-9]+(?:[.,][0-9]+)?/);
  if (!match) return row.tolerance.slice(0, 8) || "—";
  const diametral = /ø|diam|⌀/i.test(row.tolerance) ? "Ø" : "";
  return `${diametral}${match[0].replace(",", ".")}`;
}

function frameSpecOf(row: AnnotationRow): FrameSpec {
  return {
    symbol: gdtSymbolOf(`${row.tolerance} ${row.feature}`),
    tolerance: toleranceValue(row),
    datums: row.datums
      .split(/[|,/\s]+/)
      .map((datum) => datum.trim().toUpperCase())
      .filter((datum) => /^[A-Z]{1,2}$/.test(datum))
      .slice(0, 3),
  };
}

/**
 * Which feature of the part a table row talks about. The rows are written by
 * the drawing agent in prose, so the anchors are resolved by keyword.
 */
function targetKeyOf(
  row: AnnotationRow,
  datums: AnnotationDatum[],
): string | null {
  const text = `${row.feature} ${row.tolerance} ${row.nominal}`.toLowerCase();
  if (
    /pocket|slot|recess|groove|cavity|hole|bore|cut-?out|pilot|seat/.test(text)
  ) {
    if (/wall|side|perpendicular/.test(text)) return "pocket-walls";
    if (/depth|deep/.test(text)) return "pocket-depth";
    if (/cent(er|re)|position|spacing|pitch|location|located/.test(text)) {
      return "pocket-position";
    }
    return "pocket-size";
  }
  const named = text.match(/datum\s+([a-z])\b/);
  if (named) return `datum:${named[1].toUpperCase()}`;
  for (const datum of datums) {
    const words = datum.feature
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(
        (word) => word.length > 3 && !/face|plane|largest|normal/.test(word),
      );
    if (words.length > 0 && words.every((word) => text.includes(word))) {
      return `datum:${datum.label.toUpperCase()}`;
    }
  }
  if (/opposite|support face|top face|upper face|back face/.test(text)) {
    return "face-top";
  }
  if (/length|long/.test(text)) return "overall-length";
  if (/width/.test(text)) return "overall-width";
  if (/height|thick/.test(text)) return "overall-height";
  if (/flat/.test(text)) return "datum:A";
  return null;
}

const CALLOUT_RADII = [11, 14, 17, 20, 24, 28, 33];

/* ------------------------------------------------------------------ build */

/**
 * Project the part into the sheet views, lay them out as a single first-angle
 * arrangement at a common ISO scale — front view top left, the view from the
 * left beside it on the same baseline, the view from above below it on the same
 * centre lines, the section and the isometric view underneath — and annotate
 * them from the drawing table.
 */
export function buildDrawingViews(
  mesh: TriangleMesh,
  area: DrawingViewport,
  annotations?: DrawingAnnotations,
): DrawingGraphics {
  const prepared = prepareMesh(mesh);
  const features = meshFeatures(prepared);
  const views = baseViews();

  // A planar cut through the pockets, when the part has any worth showing.
  const cut = chooseCut(features);
  let cutMesh: PreparedMesh | null = null;
  let cutOutline: Segment2[] = [];
  if (cut) {
    const frame = sectionFrame(cut.axis);
    const clipped = clipMesh(mesh, cut.plane);
    cutOutline = sectionOutline(mesh, cut.plane, frame.u, frame.v);
    if (clipped.positions.length >= 9 && cutOutline.length > 0) {
      cutMesh = prepareMesh(clipped);
      views.push({
        key: "section",
        label: `Section ${cut.letter}-${cut.letter}`,
        u: frame.u,
        v: frame.v,
        w: frame.w,
        hiddenEdges: false,
        dimensions: [],
        column: 0,
        row: 2,
        cut: { plane: cut.plane, letter: cut.letter },
      });
      // The isometric view moves next to the section, keeping the sheet square.
      const iso = views.find((view) => view.key === "iso");
      if (iso) iso.row = 2;
    } else {
      cutOutline = [];
    }
  }

  const slots: Slot[] = views.map((view) => {
    const source = view.cut && cutMesh ? cutMesh : prepared;
    const projection = project(source, view);
    return { view, mesh: source, projection, size: extents(projection) };
  });

  const scale = chooseScale(slots, area);
  const layout = layoutAt(slots, scale.ratio);
  // Centre the arrangement in the drawing area without letting it drift into
  // the space reserved for the dimension lines.
  const offsetX = PAD_LEFT + Math.max(0, area.widthMm - layout.width) / 2;
  const offsetY = PAD_TOP + Math.max(0, area.heightMm - layout.height) / 2;
  const columnAt = (column: number): number =>
    offsetX +
    layout.columns
      .slice(0, column)
      .reduce((sum, width) => sum + width + COLUMN_GAP, 0);
  const rowAt = (row: number): number =>
    offsetY +
    layout.rows
      .slice(0, row)
      .reduce((sum, height) => sum + height + CAPTION_HEIGHT + ROW_GAP, 0);

  const places: Placement[] = slots.map((slot) => {
    const paperWidth = slot.size.width * scale.ratio;
    const paperHeight = slot.size.height * scale.ratio;
    const cellX = columnAt(slot.view.column);
    const cellY = rowAt(slot.view.row);
    const cellWidth = layout.columns[slot.view.column];
    const cellHeight = layout.rows[slot.view.row];
    // Aligned projections share their baseline, so a view is only centred
    // inside the slack of its own row/column.
    const left = cellX + (cellWidth - paperWidth) / 2;
    const top = cellY + (cellHeight - paperHeight) / 2;
    const toPaper = (u: number, v: number): [number, number] => [
      left + (u - slot.projection.minU) * scale.ratio,
      top + (slot.projection.maxV - v) * scale.ratio,
    ];
    const u = axisOf(slot.view.u);
    const v = axisOf(slot.view.v);
    const w = axisOf(slot.view.w);
    return {
      view: slot.view,
      mesh: slot.mesh,
      projection: slot.projection,
      size: slot.size,
      box: { x: left, y: top, width: paperWidth, height: paperHeight },
      cell: { x: cellX, y: cellY, width: cellWidth, height: cellHeight },
      toPaper,
      paperOf: (point: Vec3): Point => {
        const [x, y] = toPaper(
          dot(point, slot.view.u),
          dot(point, slot.view.v),
        );
        return { x, y };
      },
      uAxis: u.axis,
      vAxis: v.axis,
      wAxis: w.axis,
      uSign: u.sign,
      vSign: v.sign,
      wSign: w.sign,
    };
  });

  const geometry: string[] = [];
  const overlay: string[] = [];
  const space = new Occupancy({
    x: 1,
    y: 1,
    width: area.widthMm - 2,
    height: area.heightMm - 2,
  });
  const viewBoxes: Rect[] = [];
  for (const place of places) {
    viewBoxes.push(place.box);
    space.reserve(inflate(place.box, 1.2));
    space.reserve({
      x: place.cell.x,
      y: place.cell.y + place.cell.height,
      width: place.cell.width,
      height: CAPTION_HEIGHT,
    });
  }
  // The part-data box the sheet prints under the views.
  space.reserve({ x: 0, y: area.heightMm - 40, width: 84, height: 40 });

  /** A leader may cross its own view, never another one. */
  const clearLeader = (from: Point, to: Point, own: Rect): boolean =>
    viewBoxes.every(
      (box) => box === own || !crosses(from, to, inflate(box, 1)),
    );

  const targets = new Map<string, Target>();
  const remember = (key: string, target: Target): void => {
    if (!targets.has(key)) targets.set(key, target);
  };

  /* Views, their edges and the overall dimensions. */
  for (const place of places) {
    const runs = traceEdges(
      place.mesh,
      place.projection,
      place.view,
      place.toPaper,
      place.view.cut
        ? (u, v, depth) =>
            depth < place.view.cut!.plane.offset - 1e-6 &&
            insideOutline(cutOutline, u, v)
        : undefined,
    );
    // The cut surface of a section is hatched at 45° and outlined: the
    // boundary comes straight from the plane/mesh intersection, which is exact
    // where the clipped tessellation would only give open edges.
    let cutEdges = "";
    if (place.view.cut) {
      const paperOutline = cutOutline.map((edge) => {
        const [x0, y0] = place.toPaper(edge.x0, edge.y0);
        const [x1, y1] = place.toPaper(edge.x1, edge.y1);
        return { x0, y0, x1, y1 };
      });
      const hatch = hatchOutline(paperOutline, HATCH_PITCH)
        .map((edge) => segment(edge.x0, edge.y0, edge.x1, edge.y1))
        .join("");
      if (hatch) {
        geometry.push(
          `<path d="${hatch}" stroke="#16211b" stroke-width="0.18" fill="none"/>`,
        );
      }
      cutEdges = paperOutline
        .map((edge) => segment(edge.x0, edge.y0, edge.x1, edge.y1))
        .join("");
    }
    if (runs.hidden.length > 0) {
      geometry.push(
        `<path d="${runs.hidden.join("")}" fill="none" stroke="#7d8a83" stroke-width="0.18" stroke-dasharray="1.4 1" stroke-linecap="round"/>`,
      );
    }
    if (runs.visible.length > 0 || cutEdges) {
      geometry.push(
        `<path d="${runs.visible.join("")}${cutEdges}" fill="none" stroke="#16211b" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
    geometry.push(
      caption(
        place.view.label,
        place.cell.x + place.cell.width / 2,
        place.cell.y + place.cell.height + CAPTION_HEIGHT - 1.5,
      ),
    );

    const { box } = place;
    if (place.view.dimensions.includes("width")) {
      const dimension = horizontalDimension(
        box.x,
        box.x + box.width,
        box.y,
        box.y - 8,
        place.size.width.toFixed(2),
      );
      geometry.push(dimension.svg);
      space.reserve(dimension.rect);
      remember("overall-length", {
        at: dimension.anchor,
        preferDeg: -90,
        view: box,
      });
    }
    if (place.view.dimensions.includes("height")) {
      const dimension = verticalDimension(
        box.y,
        box.y + box.height,
        box.x,
        box.x - 8,
        place.size.height.toFixed(2),
      );
      geometry.push(dimension.svg);
      space.reserve(dimension.rect);
      remember(
        place.view.key === "front" ? "overall-height" : "overall-width",
        { at: dimension.anchor, preferDeg: 180, view: box },
      );
    }
  }

  const byKey = new Map(places.map((place) => [place.view.key, place]));

  /* Cutting-plane line on the view the section is taken from. */
  if (cut && byKey.has("section")) {
    const donorOrder = ["top", "front", "left"];
    const donor = places
      .filter(
        (place) =>
          place.view.key !== "section" &&
          (place.uAxis === cut.axis || place.vAxis === cut.axis) &&
          place.wAxis !== null,
      )
      .sort(
        (a, b) =>
          donorOrder.indexOf(a.view.key) - donorOrder.indexOf(b.view.key),
      )
      .find((place) => donorOrder.includes(place.view.key));
    if (donor) {
      const along = donor.uAxis === cut.axis ? "u" : "v";
      const point: Vec3 = [0, 0, 0];
      point[cut.axis] = cut.plane.offset;
      const at = donor.paperOf(point);
      const towardsRaw = {
        x: -dot(sectionFrame(cut.axis).w, donor.view.u),
        y: dot(sectionFrame(cut.axis).w, donor.view.v),
      };
      const towards = {
        x: towardsRaw.x / (Math.hypot(towardsRaw.x, towardsRaw.y) || 1),
        y: towardsRaw.y / (Math.hypot(towardsRaw.x, towardsRaw.y) || 1),
      };
      const overhang = 7;
      const from =
        along === "u"
          ? { x: at.x, y: donor.box.y - overhang }
          : { x: donor.box.x - overhang, y: at.y };
      const to =
        along === "u"
          ? { x: at.x, y: donor.box.y + donor.box.height + overhang }
          : { x: donor.box.x + donor.box.width + overhang, y: at.y };
      overlay.push(cuttingPlane({ from, to, towards, letter: cut.letter }));
      // Only the line itself and the two arrow/letter ends are claimed: the
      // paper beside the cutting plane stays available for dimensions.
      space.reserve(boundsOf([from, to], 1.5));
      for (const end of [from, to]) {
        space.reserve(
          boundsOf(
            [end, { x: end.x + towards.x * 15, y: end.y + towards.y * 15 }],
            2.5,
          ),
        );
      }
    }
  }

  /**
   * Feature dimensions of the pockets: the opening sizes and the pitch on the
   * view the pockets open towards, the depth on the section. Each dimension is
   * offered several positions and takes the first free one, so nothing lands on
   * a view, a caption or another annotation.
   */
  const drawDimension = (candidates: DimensionResult[]): boolean => {
    for (const candidate of candidates) {
      if (!space.free(candidate.rect)) continue;
      overlay.push(candidate.svg);
      space.reserve(candidate.rect);
      return true;
    }
    return false;
  };

  const array = features.arrays.find((item) => item.pockets.length >= 2);
  const pocket: PocketFeature | null =
    (array ? array.pockets[0] : features.pockets[0]) ?? null;
  const pocketCount = array ? array.pockets.length : pocket ? 1 : 0;
  if (pocket) {
    const opening = places.find(
      (place) =>
        place.wAxis === pocket.depthAxis &&
        place.wSign === pocket.openingSign &&
        place.view.key !== "section",
    );
    if (opening && opening.uAxis !== null && opening.vAxis !== null) {
      const rect = paperRectOf(opening, pocket.min, pocket.max);
      const uSize = pocket.max[opening.uAxis] - pocket.min[opening.uAxis];
      const vSize = pocket.max[opening.vAxis] - pocket.min[opening.vAxis];
      const prefix = pocketCount > 1 ? `${pocketCount}× ` : "";
      const above = opening.box.y;
      const right = opening.box.x + opening.box.width;
      // Opening size across the view.
      drawDimension(
        [above - 9, above - 18, above - 27].map((at) =>
          horizontalDimension(
            rect.x,
            rect.x + rect.width,
            above,
            at,
            `${prefix}${uSize.toFixed(2)}`,
          ),
        ),
      );
      // Opening size along the view, dimensioned from the nearer side.
      drawDimension(
        [right + 9, right + 18, opening.box.x - 18, opening.box.x - 27].map(
          (at) =>
            verticalDimension(
              rect.y,
              rect.y + rect.height,
              at > right ? rect.x + rect.width : rect.x,
              at,
              vSize.toFixed(2),
            ),
        ),
      );
      // Pitch of the array and its location from the nearest end face. Both
      // are stated on the view with room for them: the section, when the part
      // has one, is aligned with the opening view and has free paper below it.
      const pitchHost = byKey.get("section") ?? opening;
      if (
        array &&
        array.pitchMm > 0 &&
        axisIsHorizontal(pitchHost, array.arrayAxis)
      ) {
        const first = paperRectOf(
          pitchHost,
          array.pockets[0].min,
          array.pockets[0].max,
        );
        const second = paperRectOf(
          pitchHost,
          array.pockets[1].min,
          array.pockets[1].max,
        );
        const hostBelow = pitchHost.box.y + pitchHost.box.height;
        const hostAbove = pitchHost.box.y;
        drawDimension(
          [
            [hostBelow + 9, hostBelow],
            [hostBelow + 18, hostBelow],
            [hostAbove - 18, hostAbove],
            [hostAbove - 27, hostAbove],
          ].map(([at, base]) =>
            horizontalDimension(
              first.x + first.width / 2,
              second.x + second.width / 2,
              base,
              at,
              `${array.pockets.length - 1}× ${array.pitchMm.toFixed(2)}`,
            ),
          ),
        );
      }
      const near = array ? array.pockets[array.pockets.length - 1] : pocket;
      const locationHost = byKey.get("section") ?? opening;
      if (locationHost.uAxis !== null && locationHost.vAxis !== null) {
        const endAxis = locationHost.uAxis;
        const nearRect = paperRectOf(locationHost, near.min, near.max);
        const face: Vec3 = [...near.centroid];
        face[endAxis] =
          Math.abs(features.max[endAxis] - near.max[endAxis]) <
          Math.abs(near.min[endAxis] - features.min[endAxis])
            ? features.max[endAxis]
            : features.min[endAxis];
        const facePoint = locationHost.paperOf(face);
        const centreX = nearRect.x + nearRect.width / 2;
        const hostBelow = locationHost.box.y + locationHost.box.height;
        const hostAbove = locationHost.box.y;
        if (Math.abs(facePoint.x - centreX) > 3) {
          drawDimension(
            [
              [hostBelow + 18, hostBelow],
              [hostBelow + 27, hostBelow],
              [hostAbove - 9, hostAbove],
              [hostAbove - 18, hostAbove],
            ].map(([at, base]) =>
              horizontalDimension(
                facePoint.x,
                centreX,
                base,
                at,
                Math.abs(face[endAxis] - near.centroid[endAxis]).toFixed(2),
              ),
            ),
          );
        }
      }
      remember("pocket-size", {
        at: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        preferDeg: -90,
        view: opening.box,
      });
      const positionRect = paperRectOf(
        opening,
        (array ? array.pockets[array.pockets.length - 1] : pocket).min,
        (array ? array.pockets[array.pockets.length - 1] : pocket).max,
      );
      remember("pocket-position", {
        at: {
          x: positionRect.x + positionRect.width / 2,
          y: positionRect.y + positionRect.height / 2,
        },
        preferDeg: -90,
        view: opening.box,
      });
    }

    /* Depth and walls of the pocket are shown on the section. */
    const section = byKey.get("section");
    if (section && section.vAxis === pocket.depthAxis) {
      // Measure the pocket closest to the right edge of the view so the
      // extension lines of the depth dimension stay short.
      const deep = array
        ? array.pockets.reduce((best, item) =>
            item.centroid[section.uAxis ?? 0] * (section.uSign as number) >
            best.centroid[section.uAxis ?? 0] * (section.uSign as number)
              ? item
              : best,
          )
        : pocket;
      const floor: Vec3 = [...deep.centroid];
      const rim: Vec3 = [...deep.centroid];
      floor[deep.depthAxis] = deep.floor;
      rim[deep.depthAxis] = deep.rim;
      const floorPoint = section.paperOf(floor);
      const rimPoint = section.paperOf(rim);
      const wall = paperRectOf(section, deep.min, deep.max);
      const right = section.box.x + section.box.width;
      drawDimension(
        [right + 9, right + 18, section.box.x - 9].map((at) =>
          verticalDimension(
            rimPoint.y,
            floorPoint.y,
            at > right ? wall.x + wall.width : wall.x,
            at,
            deep.depthMm.toFixed(2),
          ),
        ),
      );
      remember("pocket-depth", {
        at: { x: floorPoint.x, y: floorPoint.y },
        preferDeg: 90,
        view: section.box,
      });
      remember("pocket-walls", {
        at: { x: wall.x, y: (rimPoint.y + floorPoint.y) / 2 },
        preferDeg: 180,
        view: section.box,
      });
    } else {
      const front = byKey.get("front");
      if (front) {
        const rect = paperRectOf(front, pocket.min, pocket.max);
        remember("pocket-depth", {
          at: { x: rect.x + rect.width / 2, y: rect.y },
          preferDeg: 90,
          view: front.box,
        });
        remember("pocket-walls", {
          at: { x: rect.x, y: rect.y + rect.height / 2 },
          preferDeg: 180,
          view: front.box,
        });
      }
    }
  }

  /* Datum indicators and the faces the table refers to. */
  const balloonedRows: number[] = [];
  if (annotations) {
    const datums = datumPlacements(features, annotations.datums);
    for (const datum of datums) {
      const spot = faceSpot(places, features, datum.axis, datum.sign);
      if (!spot) continue;
      // Control frames of the same face attach further along it, so they never
      // land on top of the datum triangle.
      const callout =
        faceSpot(places, features, datum.axis, datum.sign, 0.55) ?? spot;
      remember(`datum:${datum.label.toUpperCase()}`, {
        at: callout.at,
        preferDeg: callout.preferDeg,
        view: callout.view,
      });
      const size = datumBoxSize();
      const rect = space.place(
        spot.at,
        size,
        directions(spot.preferDeg, 8),
        [9, 12, 15, 19],
        (candidate) => clearLeader(centreOf(candidate), spot.at, spot.view),
      );
      if (!rect) continue;
      overlay.push(datumIndicator(rect, datum.label, spot.at, spot.outward));
      space.reserve(inflate(rect, 0.6));
    }
    // The face opposite the primary datum, used by parallelism rows.
    const primary = datums[0] ?? { axis: 1 as Axis, sign: -1 as 1 | -1 };
    const opposite = faceSpot(
      places,
      features,
      primary.axis,
      (primary.sign === 1 ? -1 : 1) as 1 | -1,
      0.42,
    );
    if (opposite) {
      remember("face-top", {
        at: opposite.at,
        preferDeg: opposite.preferDeg,
        view: opposite.view,
      });
    }

    /* Balloons and feature control frames, row by row. */
    annotations.rows.forEach((row, index) => {
      const key = targetKeyOf(row, annotations.datums);
      const target = key ? targets.get(key) : undefined;
      if (!target) return;
      const number = String(index + 1);
      const spec = row.kind === "gdt" ? frameSpecOf(row) : null;
      const size = spec ? frameSize(spec) : { width: 0, height: 0 };
      const group = spec
        ? {
            width: BALLOON_RADIUS * 2 + 1 + size.width,
            height: Math.max(BALLOON_RADIUS * 2, size.height),
          }
        : { width: BALLOON_RADIUS * 2, height: BALLOON_RADIUS * 2 };
      const rect = space.place(
        target.at,
        group,
        directions(target.preferDeg),
        CALLOUT_RADII,
        (candidate) => clearLeader(centreOf(candidate), target.at, target.view),
      );
      if (!rect) return;
      const centre = centreOf(rect);
      if (spec) {
        const frame: Rect = {
          x: rect.x + BALLOON_RADIUS * 2 + 1,
          y: centre.y - size.height / 2,
          width: size.width,
          height: size.height,
        };
        const anchor = { x: rect.x + BALLOON_RADIUS, y: centre.y };
        overlay.push(
          frameWithLeader(frame, spec, target.at),
          balloonSvg(anchor, edgePoint(frame, anchor), number),
        );
      } else {
        overlay.push(balloonSvg(centre, target.at, number));
      }
      space.reserve(inflate(rect, 0.8));
      balloonedRows.push(index + 1);
    });
  }

  return {
    scale,
    bottomFreeMm: Math.max(0, (area.heightMm - layout.height) / 2),
    balloonedRows,
    views: places.map((place) => ({
      key: place.view.key,
      label: place.view.label,
      widthMm: place.size.width,
      heightMm: place.size.height,
    })),
    svg: `<svg viewBox="0 0 ${round(area.widthMm)} ${round(area.heightMm)}" width="${round(area.widthMm)}mm" height="${round(area.heightMm)}mm" xmlns="http://www.w3.org/2000/svg">${geometry.join("")}${overlay.join("")}</svg>`,
  };
}

/** Paper rectangle covered by a part-space box in one view. */
function paperRectOf(place: Placement, min: Vec3, max: Vec3): Rect {
  const points: Point[] = [];
  for (let corner = 0; corner < 8; corner += 1) {
    points.push(
      place.paperOf([
        corner & 1 ? max[0] : min[0],
        corner & 2 ? max[1] : min[1],
        corner & 4 ? max[2] : min[2],
      ]),
    );
  }
  return boundsOf(points);
}

/** Whether a part axis runs left-to-right in a view. */
function axisIsHorizontal(place: Placement, axis: Axis): boolean {
  return place.uAxis === axis;
}

/**
 * A spot on the silhouette where a face is seen edge-on: the datum triangle and
 * the control frames of that face attach there.
 */
function faceSpot(
  places: Placement[],
  features: MeshFeatures,
  axis: Axis,
  sign: 1 | -1,
  /** Where along the projected face the symbol is attached, 0…1. */
  fraction = 0.28,
): { at: Point; outward: Point; preferDeg: number; view: Rect } | null {
  const order = ["front", "top", "left", "section"];
  const candidates = places
    .filter(
      (place) =>
        (place.uAxis === axis || place.vAxis === axis) &&
        place.view.key !== "iso",
    )
    .sort((a, b) => order.indexOf(a.view.key) - order.indexOf(b.view.key));
  const place = candidates[0];
  if (!place) return null;
  const face = features.faces.find(
    (item) => item.axis === axis && item.sign === sign,
  );
  const level = face
    ? face.sign * face.offset
    : sign > 0
      ? features.max[axis]
      : features.min[axis];
  const horizontal = place.uAxis === axis;
  // Project the face plane, then walk along it to a point that is inside the
  // silhouette of the view.
  const along: Axis = horizontal
    ? place.vAxis !== null
      ? place.vAxis
      : axis
    : place.uAxis !== null
      ? place.uAxis
      : axis;
  const from: Vec3 = [0, 0, 0];
  from[axis] = level;
  from[along] =
    features.min[along] +
    (features.max[along] - features.min[along]) * fraction;
  const at = place.paperOf(from);
  const outwardRaw = horizontal
    ? { x: sign * place.uSign, y: 0 }
    : { x: 0, y: -sign * place.vSign };
  return {
    at,
    outward: outwardRaw,
    preferDeg: (Math.atan2(outwardRaw.y, outwardRaw.x) * 180) / Math.PI,
    view: place.box,
  };
}

/** Liang–Barsky test: does the segment enter the rectangle? */
function crosses(from: Point, to: Point, rect: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, from.x - rect.x) &&
    clip(dx, rect.x + rect.width - from.x) &&
    clip(-dy, from.y - rect.y) &&
    clip(dy, rect.y + rect.height - from.y) &&
    t0 < t1
  );
}
