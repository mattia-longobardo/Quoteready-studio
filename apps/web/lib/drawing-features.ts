/**
 * Geometry the drawing annotations are derived from. The tessellation archived
 * for a part carries no CAD topology, so this module rebuilds the little that
 * the sheet needs: an indexed mesh with edge adjacency, the connected planar
 * faces of the solid, the recessed features (pockets/slots) and their arrays,
 * plus the planar-cut helpers the section view uses. Everything is CPU-only and
 * in part millimetres.
 */

import type { TriangleMesh, Vec3 } from "@/lib/gltf-mesh";

/** 0 = X, 1 = Y, 2 = Z of the part coordinate system. */
export type Axis = 0 | 1 | 2;

interface Edge {
  a: number;
  b: number;
  faceA: number;
  faceB: number;
}

export interface PreparedMesh {
  /** Welded vertices, 3 floats each. */
  vertices: Float64Array;
  /** Triangle corner indices, 3 per face. */
  faces: Int32Array;
  /** Unit face normals, 3 per face. */
  normals: Float64Array;
  edges: Edge[];
  diagonal: number;
  min: Vec3;
  max: Vec3;
}

/** A connected set of coplanar triangles: one planar face of the solid. */
interface PlanarFace {
  /** Outward unit normal, snapped when it is within tolerance of an axis. */
  normal: Vec3;
  /** Plane offset, i.e. dot(point, normal). */
  offset: number;
  areaMm2: number;
  min: Vec3;
  max: Vec3;
  centroid: Vec3;
  /** Set when the normal is axis-aligned; the pocket/datum logic needs it. */
  axis: Axis | null;
  /** Direction of the normal along {@link axis}: +1 towards max, -1 to min. */
  sign: 1 | -1;
}

/** A face recessed below the surrounding surface: a pocket, slot or step. */
export interface PocketFeature {
  /** Axis the depth is measured along. */
  depthAxis: Axis;
  /** Side of the part the pocket opens on: +1 = max face, -1 = min face. */
  openingSign: 1 | -1;
  depthMm: number;
  /** Pocket floor position along {@link depthAxis}, in part coordinates. */
  floor: number;
  /** Rim the depth is measured from, in part coordinates. */
  rim: number;
  min: Vec3;
  max: Vec3;
  centroid: Vec3;
  areaMm2: number;
}

/** Identical pockets repeated along one axis at a constant pitch. */
interface PocketArray {
  pockets: PocketFeature[];
  /** Axis the pockets are arrayed along. */
  arrayAxis: Axis;
  pitchMm: number;
}

export interface MeshFeatures {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  faces: PlanarFace[];
  pockets: PocketFeature[];
  arrays: PocketArray[];
}

/** Coplanarity tolerances used when growing a planar face. */
const COPLANAR_COS = Math.cos((0.75 * Math.PI) / 180);
const COPLANAR_OFFSET_MM = 0.02;
/** A normal this close to an axis is treated as axis-aligned. */
const AXIS_COS = Math.cos((1 * Math.PI) / 180);
/** Faces smaller than this are tessellation debris, not features. */
const MIN_FACE_AREA_MM2 = 0.5;
/** Below this a "recess" is just surface noise. */
const MIN_RECESS_MM = 0.3;
/** Sizes/positions within this are considered equal when grouping pockets. */
const SAME_MM = 0.08;
/**
 * How many candidate floors are ray-tested for reachability. The test is linear
 * in the triangle count, and the faces are visited largest first, so the cap
 * bounds the export time on a heavily tessellated model without losing any
 * feature big enough to be worth dimensioning.
 */
const MAX_POCKET_PROBES = 40;

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Weld the triangle soup into an indexed mesh with an edge/face adjacency map:
 * the feature-edge test, the hidden-line pass and the planar-face grouping all
 * need to know which faces meet along an edge.
 */
export function prepareMesh(mesh: TriangleMesh): PreparedMesh {
  const faceCount = Math.floor(mesh.positions.length / 9);
  const vertices: number[] = [];
  const faces = new Int32Array(faceCount * 3);
  const normals = new Float64Array(faceCount * 3);
  const lookup = new Map<string, number>();
  const edges = new Map<string, Edge>();

  for (let face = 0; face < faceCount; face += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const at = face * 9 + corner * 3;
      const x = mesh.positions[at];
      const y = mesh.positions[at + 1];
      const z = mesh.positions[at + 2];
      // Micron-level quantisation welds the per-face vertices Zoo's
      // tessellation emits without merging genuinely distinct corners.
      const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
      let index = lookup.get(key);
      if (index === undefined) {
        index = vertices.length / 3;
        lookup.set(key, index);
        vertices.push(x, y, z);
      }
      faces[face * 3 + corner] = index;
    }
    const [i0, i1, i2] = [
      faces[face * 3],
      faces[face * 3 + 1],
      faces[face * 3 + 2],
    ];
    const ax = vertices[i1 * 3] - vertices[i0 * 3];
    const ay = vertices[i1 * 3 + 1] - vertices[i0 * 3 + 1];
    const az = vertices[i1 * 3 + 2] - vertices[i0 * 3 + 2];
    const bx = vertices[i2 * 3] - vertices[i0 * 3];
    const by = vertices[i2 * 3 + 1] - vertices[i0 * 3 + 1];
    const bz = vertices[i2 * 3 + 2] - vertices[i0 * 3 + 2];
    const normal = normalize([
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx,
    ]);
    normals.set(normal, face * 3);
    for (let corner = 0; corner < 3; corner += 1) {
      const a = faces[face * 3 + corner];
      const b = faces[face * 3 + ((corner + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = edges.get(key);
      if (existing) {
        if (existing.faceB < 0) existing.faceB = face;
      } else {
        edges.set(key, { a, b, faceA: face, faceB: -1 });
      }
    }
  }

  const diagonal = Math.hypot(
    mesh.max[0] - mesh.min[0],
    mesh.max[1] - mesh.min[1],
    mesh.max[2] - mesh.min[2],
  );
  return {
    vertices: Float64Array.from(vertices),
    faces,
    normals,
    edges: [...edges.values()],
    diagonal: diagonal || 1,
    min: mesh.min,
    max: mesh.max,
  };
}

/** Union-find over the triangles, used to grow connected coplanar patches. */
class Groups {
  private readonly parent: Int32Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    for (let index = 0; index < count; index += 1) this.parent[index] = index;
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let walk = index;
    while (this.parent[walk] !== walk) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

function faceArea(mesh: PreparedMesh, face: number): number {
  const a = mesh.faces[face * 3] * 3;
  const b = mesh.faces[face * 3 + 1] * 3;
  const c = mesh.faces[face * 3 + 2] * 3;
  const ux = mesh.vertices[b] - mesh.vertices[a];
  const uy = mesh.vertices[b + 1] - mesh.vertices[a + 1];
  const uz = mesh.vertices[b + 2] - mesh.vertices[a + 2];
  const vx = mesh.vertices[c] - mesh.vertices[a];
  const vy = mesh.vertices[c + 1] - mesh.vertices[a + 1];
  const vz = mesh.vertices[c + 2] - mesh.vertices[a + 2];
  return (
    Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  );
}

function faceOffset(mesh: PreparedMesh, face: number): number {
  let sum = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    let mean = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      mean += mesh.vertices[mesh.faces[face * 3 + corner] * 3 + axis] / 3;
    }
    sum += mean * mesh.normals[face * 3 + axis];
  }
  return sum;
}

/** Group the triangles into the connected planar faces of the solid. */
function planarFaces(mesh: PreparedMesh): PlanarFace[] {
  const faceCount = mesh.faces.length / 3;
  const groups = new Groups(faceCount);
  const offsets = new Float64Array(faceCount);
  for (let face = 0; face < faceCount; face += 1) {
    offsets[face] = faceOffset(mesh, face);
  }
  for (const edge of mesh.edges) {
    if (edge.faceB < 0) continue;
    const a = edge.faceA;
    const b = edge.faceB;
    const cosine =
      mesh.normals[a * 3] * mesh.normals[b * 3] +
      mesh.normals[a * 3 + 1] * mesh.normals[b * 3 + 1] +
      mesh.normals[a * 3 + 2] * mesh.normals[b * 3 + 2];
    if (cosine < COPLANAR_COS) continue;
    if (Math.abs(offsets[a] - offsets[b]) > COPLANAR_OFFSET_MM) continue;
    groups.union(a, b);
  }

  interface Accumulator {
    area: number;
    normal: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
    centroid: [number, number, number];
  }
  const patches = new Map<number, Accumulator>();
  for (let face = 0; face < faceCount; face += 1) {
    const root = groups.find(face);
    let patch = patches.get(root);
    if (!patch) {
      patch = {
        area: 0,
        normal: [0, 0, 0],
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        centroid: [0, 0, 0],
      };
      patches.set(root, patch);
    }
    const area = faceArea(mesh, face);
    patch.area += area;
    for (let axis = 0; axis < 3; axis += 1) {
      patch.normal[axis] += mesh.normals[face * 3 + axis] * area;
      let mean = 0;
      for (let corner = 0; corner < 3; corner += 1) {
        const value = mesh.vertices[mesh.faces[face * 3 + corner] * 3 + axis];
        mean += value / 3;
        if (value < patch.min[axis]) patch.min[axis] = value;
        if (value > patch.max[axis]) patch.max[axis] = value;
      }
      patch.centroid[axis] += mean * area;
    }
  }

  const result: PlanarFace[] = [];
  for (const patch of patches.values()) {
    if (patch.area < MIN_FACE_AREA_MM2) continue;
    let normal = normalize(patch.normal);
    let axis: Axis | null = null;
    let sign: 1 | -1 = 1;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      if (Math.abs(normal[candidate]) >= AXIS_COS) {
        axis = candidate as Axis;
        sign = normal[candidate] > 0 ? 1 : -1;
        const snapped: Vec3 = [0, 0, 0];
        snapped[candidate] = sign;
        normal = snapped;
      }
    }
    const centroid: Vec3 = [
      patch.centroid[0] / patch.area,
      patch.centroid[1] / patch.area,
      patch.centroid[2] / patch.area,
    ];
    result.push({
      normal,
      offset: dot(centroid, normal),
      areaMm2: patch.area,
      min: [patch.min[0], patch.min[1], patch.min[2]],
      max: [patch.max[0], patch.max[1], patch.max[2]],
      centroid,
      axis,
      sign,
    });
  }
  return result.sort((a, b) => b.areaMm2 - a.areaMm2);
}

/** The two axes across `axis`, in ascending order. */
export function crossAxes(axis: Axis): [Axis, Axis] {
  const others = ([0, 1, 2] as Axis[]).filter((value) => value !== axis);
  return [others[0], others[1]];
}

/**
 * Whether a ray leaves the solid without meeting material: the test that tells
 * a real pocket floor (reachable straight on, so it can be milled and
 * dimensioned on that view) from a face that merely happens to sit below the
 * envelope, such as the far wall of a slot.
 */
function raySeesOutside(
  mesh: PreparedMesh,
  origin: Vec3,
  direction: Vec3,
): boolean {
  const faceCount = mesh.faces.length / 3;
  for (let face = 0; face < faceCount; face += 1) {
    const a = mesh.faces[face * 3] * 3;
    const b = mesh.faces[face * 3 + 1] * 3;
    const c = mesh.faces[face * 3 + 2] * 3;
    const e1: Vec3 = [
      mesh.vertices[b] - mesh.vertices[a],
      mesh.vertices[b + 1] - mesh.vertices[a + 1],
      mesh.vertices[b + 2] - mesh.vertices[a + 2],
    ];
    const e2: Vec3 = [
      mesh.vertices[c] - mesh.vertices[a],
      mesh.vertices[c + 1] - mesh.vertices[a + 1],
      mesh.vertices[c + 2] - mesh.vertices[a + 2],
    ];
    const pvec = cross(direction, e2);
    const determinant = dot(e1, pvec);
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const tvec: Vec3 = [
      origin[0] - mesh.vertices[a],
      origin[1] - mesh.vertices[a + 1],
      origin[2] - mesh.vertices[a + 2],
    ];
    const u = dot(tvec, pvec) * inverse;
    if (u < 0 || u > 1) continue;
    const qvec = cross(tvec, e1);
    const v = dot(direction, qvec) * inverse;
    if (v < 0 || u + v > 1) continue;
    // Ignore the floor the ray starts on, and anything behind the origin.
    if (dot(e2, qvec) * inverse > 0.05) return false;
  }
  return true;
}

/**
 * Recessed planar faces of the solid: a face that looks outward along an axis,
 * sits below the envelope of that side and is reachable straight on is the
 * floor of a pocket, slot or step. The depth is measured up to the rim the
 * surrounding walls reach.
 */
function findPockets(
  mesh: PreparedMesh,
  faces: PlanarFace[],
  min: Vec3,
  max: Vec3,
): PocketFeature[] {
  const pockets: PocketFeature[] = [];
  let probes = 0;
  for (const face of faces) {
    if (probes >= MAX_POCKET_PROBES) break;
    const axis = face.axis;
    if (axis === null) continue;
    const sign = face.sign;
    // Outward height: larger means closer to the outside of that side. The
    // plane offset is already measured along the outward normal.
    const height = (value: number): number => sign * value;
    const outer = height(sign > 0 ? max[axis] : min[axis]);
    const floor = face.offset;
    if (outer - floor < MIN_RECESS_MM) continue;
    const [p, q] = crossAxes(axis);
    let rim = -Infinity;
    for (const wall of faces) {
      if (wall.axis === axis) continue;
      if (Math.abs(wall.normal[axis]) > 0.2) continue;
      const touches =
        Math.abs(height(sign > 0 ? wall.min[axis] : wall.max[axis]) - floor) <
        0.25;
      if (!touches) continue;
      const overlaps =
        wall.min[p] < face.max[p] + 0.25 &&
        wall.max[p] > face.min[p] - 0.25 &&
        wall.min[q] < face.max[q] + 0.25 &&
        wall.max[q] > face.min[q] - 0.25;
      if (!overlaps) continue;
      rim = Math.max(rim, height(sign > 0 ? wall.max[axis] : wall.min[axis]));
    }
    if (!Number.isFinite(rim)) rim = outer;
    const depth = rim - floor;
    if (depth < MIN_RECESS_MM) continue;
    probes += 1;
    if (!raySeesOutside(mesh, face.centroid, face.normal)) continue;
    pockets.push({
      depthAxis: axis,
      openingSign: sign,
      depthMm: depth,
      floor: sign * face.offset,
      rim: sign * rim,
      min: face.min,
      max: face.max,
      centroid: face.centroid,
      areaMm2: face.areaMm2,
    });
  }
  return pockets.sort((a, b) => b.areaMm2 - a.areaMm2);
}

/** Whether two pockets are the same feature repeated somewhere else. */
function samePocket(a: PocketFeature, b: PocketFeature): boolean {
  if (a.depthAxis !== b.depthAxis || a.openingSign !== b.openingSign) {
    return false;
  }
  const [p, q] = crossAxes(a.depthAxis);
  const size = (pocket: PocketFeature, axis: Axis): number =>
    pocket.max[axis] - pocket.min[axis];
  return (
    Math.abs(a.depthMm - b.depthMm) <= SAME_MM &&
    Math.abs(a.floor - b.floor) <= SAME_MM &&
    Math.abs(size(a, p) - size(b, p)) <= SAME_MM &&
    Math.abs(size(a, q) - size(b, q)) <= SAME_MM
  );
}

/** Collect identical pockets repeated at a constant pitch along one axis. */
function findArrays(pockets: PocketFeature[]): PocketArray[] {
  // Grouped by tolerance rather than by a hashed key: rounding a quantised key
  // would split a run of identical pockets across a bucket boundary.
  const buckets: PocketFeature[][] = [];
  for (const pocket of pockets) {
    const bucket = buckets.find((candidate) =>
      samePocket(candidate[0], pocket),
    );
    if (bucket) bucket.push(pocket);
    else buckets.push([pocket]);
  }

  const arrays: PocketArray[] = [];
  for (const bucket of buckets) {
    if (bucket.length < 2) continue;
    const [p, q] = crossAxes(bucket[0].depthAxis);
    const spread = (axis: Axis): number => {
      const values = bucket.map((pocket) => pocket.centroid[axis]);
      return Math.max(...values) - Math.min(...values);
    };
    const arrayAxis = spread(p) >= spread(q) ? p : q;
    if (spread(arrayAxis) < SAME_MM) continue;
    const sorted = [...bucket].sort(
      (a, b) => a.centroid[arrayAxis] - b.centroid[arrayAxis],
    );
    const steps: number[] = [];
    for (let index = 1; index < sorted.length; index += 1) {
      steps.push(
        sorted[index].centroid[arrayAxis] -
          sorted[index - 1].centroid[arrayAxis],
      );
    }
    const pitch = steps.reduce((sum, step) => sum + step, 0) / steps.length;
    const even = steps.every((step) => Math.abs(step - pitch) <= 0.2);
    arrays.push({ pockets: sorted, arrayAxis, pitchMm: even ? pitch : 0 });
  }
  return arrays.sort((a, b) => b.pockets.length - a.pockets.length);
}

/** Everything the annotation pass knows about the shape of the part. */
export function meshFeatures(mesh: PreparedMesh): MeshFeatures {
  const faces = planarFaces(mesh);
  const pockets = findPockets(mesh, faces, mesh.min, mesh.max);
  return {
    min: mesh.min,
    max: mesh.max,
    size: [
      mesh.max[0] - mesh.min[0],
      mesh.max[1] - mesh.min[1],
      mesh.max[2] - mesh.min[2],
    ],
    faces,
    pockets,
    arrays: findArrays(pockets),
  };
}

/**
 * Largest planar face looking along `axis` towards `sign`, i.e. the candidate
 * datum feature on that side of the part.
 */
export function outerFace(
  features: MeshFeatures,
  axis: Axis,
  sign: 1 | -1,
): PlanarFace | null {
  const outer = sign > 0 ? features.max[axis] : features.min[axis];
  const flush = features.faces.filter(
    (face) =>
      face.axis === axis &&
      face.sign === sign &&
      Math.abs(face.offset * sign - outer * sign) <= 0.2,
  );
  const pool = flush.length > 0 ? flush : features.faces;
  return pool.find((face) => face.axis === axis && face.sign === sign) ?? null;
}

/** Cutting plane of a section view: material with dot(p, normal) > offset goes. */
export interface CutPlane {
  normal: Vec3;
  offset: number;
}

/**
 * Keep the half of the mesh behind the cutting plane, splitting the triangles
 * the plane crosses (Sutherland–Hodgman against one half-space, fanned back
 * into triangles). Winding — and therefore the face normals — is preserved.
 */
export function clipMesh(mesh: TriangleMesh, plane: CutPlane): TriangleMesh {
  const out: number[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const triangles = Math.floor(mesh.positions.length / 9);
  const distance = (at: number): number =>
    mesh.positions[at] * plane.normal[0] +
    mesh.positions[at + 1] * plane.normal[1] +
    mesh.positions[at + 2] * plane.normal[2] -
    plane.offset;

  const push = (point: Vec3): void => {
    for (let axis = 0; axis < 3; axis += 1) {
      out.push(point[axis]);
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
  };

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const base = triangle * 9;
    const corners: Vec3[] = [];
    const distances: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const at = base + corner * 3;
      corners.push([
        mesh.positions[at],
        mesh.positions[at + 1],
        mesh.positions[at + 2],
      ]);
      distances.push(distance(at));
    }
    if (distances.every((value) => value > 0)) continue;
    if (distances.every((value) => value <= 0)) {
      for (const corner of corners) push(corner);
      continue;
    }
    const kept: Vec3[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const next = (corner + 1) % 3;
      const here = distances[corner];
      const there = distances[next];
      if (here <= 0) kept.push(corners[corner]);
      if (here === 0 || there === 0 || here > 0 === there > 0) continue;
      const t = here / (here - there);
      kept.push([
        corners[corner][0] + (corners[next][0] - corners[corner][0]) * t,
        corners[corner][1] + (corners[next][1] - corners[corner][1]) * t,
        corners[corner][2] + (corners[next][2] - corners[corner][2]) * t,
      ]);
    }
    for (let corner = 2; corner < kept.length; corner += 1) {
      push(kept[0]);
      push(kept[corner - 1]);
      push(kept[corner]);
    }
  }
  if (out.length < 9) return { positions: new Float64Array(0), min, max };
  return { positions: Float64Array.from(out), min, max };
}

export interface Segment2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Boundary of the cut surface: the segments where the plane crosses the mesh,
 * expressed in the (u, v) frame the section view is drawn in. Coplanar
 * triangles are skipped, so callers should offset the plane away from any
 * planar face of the part before cutting.
 */
export function sectionOutline(
  mesh: TriangleMesh,
  plane: CutPlane,
  u: Vec3,
  v: Vec3,
): Segment2[] {
  const segments: Segment2[] = [];
  const triangles = Math.floor(mesh.positions.length / 9);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const base = triangle * 9;
    const corners: Vec3[] = [];
    const distances: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const at = base + corner * 3;
      const point: Vec3 = [
        mesh.positions[at],
        mesh.positions[at + 1],
        mesh.positions[at + 2],
      ];
      corners.push(point);
      distances.push(dot(point, plane.normal) - plane.offset);
    }
    const hits: [number, number][] = [];
    for (let corner = 0; corner < 3 && hits.length < 2; corner += 1) {
      const next = (corner + 1) % 3;
      const here = distances[corner];
      const there = distances[next];
      if (here > 0 === there > 0) continue;
      const t = here / (here - there);
      const point: Vec3 = [
        corners[corner][0] + (corners[next][0] - corners[corner][0]) * t,
        corners[corner][1] + (corners[next][1] - corners[corner][1]) * t,
        corners[corner][2] + (corners[next][2] - corners[corner][2]) * t,
      ];
      hits.push([dot(point, u), dot(point, v)]);
    }
    if (hits.length < 2) continue;
    const [start, end] = hits;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-6) continue;
    segments.push({ x0: start[0], y0: start[1], x1: end[0], y1: end[1] });
  }
  return segments;
}

/**
 * Even-odd test against a closed boundary given as an unordered segment soup:
 * counts the crossings of the ray going towards +y.
 */
export function insideOutline(
  outline: Segment2[],
  x: number,
  y: number,
): boolean {
  let crossings = 0;
  for (const segment of outline) {
    const { x0, y0, x1, y1 } = segment;
    if (x0 === x1) continue;
    if (x < Math.min(x0, x1) || x >= Math.max(x0, x1)) continue;
    const t = (x - x0) / (x1 - x0);
    if (y0 + (y1 - y0) * t > y) crossings += 1;
  }
  return crossings % 2 === 1;
}

/**
 * Section hatching: 45° lines at `spacing`, trimmed to the material by the
 * even-odd rule along each line. Coordinates are whatever frame `outline` is
 * in, so callers hatch in paper millimetres to keep the pitch constant.
 */
export function hatchOutline(
  outline: Segment2[],
  spacing: number,
  angleDeg = 45,
): Segment2[] {
  if (outline.length === 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const segment of outline) {
    minX = Math.min(minX, segment.x0, segment.x1);
    maxX = Math.max(maxX, segment.x0, segment.x1);
    minY = Math.min(minY, segment.y0, segment.y1);
    maxY = Math.max(maxY, segment.y0, segment.y1);
  }
  const angle = (angleDeg * Math.PI) / 180;
  // Direction of the hatch lines and the normal the family is stepped along.
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const corners: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  const offsets = corners.map(([x, y]) => x * nx + y * ny);
  const start = Math.ceil(Math.min(...offsets) / spacing) * spacing;
  const end = Math.max(...offsets);
  const lines: Segment2[] = [];
  const span = Math.hypot(maxX - minX, maxY - minY) + spacing;
  for (let offset = start; offset <= end; offset += spacing) {
    // Any point on the line, then walk it and collect the crossings.
    const originX = nx * offset;
    const originY = ny * offset;
    const hits: number[] = [];
    for (const segment of outline) {
      const ex = segment.x1 - segment.x0;
      const ey = segment.y1 - segment.y0;
      // The line is { p : p · n = offset }; solve it along the segment.
      const denominator = ex * nx + ey * ny;
      if (Math.abs(denominator) < 1e-12) continue;
      const s = (offset - (segment.x0 * nx + segment.y0 * ny)) / denominator;
      if (s < 0 || s >= 1) continue;
      const px = segment.x0 + ex * s;
      const py = segment.y0 + ey * s;
      hits.push((px - originX) * dx + (py - originY) * dy);
    }
    if (hits.length < 2) continue;
    hits.sort((a, b) => a - b);
    for (let index = 0; index + 1 < hits.length; index += 2) {
      const from = hits[index];
      const to = hits[index + 1];
      if (to - from < 0.05 || to - from > span * 2) continue;
      lines.push({
        x0: originX + dx * from,
        y0: originY + dy * from,
        x1: originX + dx * to,
        y1: originY + dy * to,
      });
    }
  }
  return lines;
}
