/**
 * Closed triangle mesh of a slotted block, in millimetres: a plain prism with
 * a row of identical rectangular slots milled into its top face. It exercises
 * the whole annotation chain — planar faces, pockets, arrays and the section
 * cut — without needing a CAD kernel.
 */

import type { TriangleMesh, Vec3 } from "@/lib/gltf-mesh";

export const BLOCK = { length: 100, height: 20, width: 30 };
export const SLOT = {
  /** Width along X, and the pitch of the array. */
  width: 6,
  pitch: 20,
  /** Extent along Z. */
  from: 8,
  to: 22,
  depth: 8,
  starts: [20, 40, 60],
};

function push(out: number[], point: Vec3): void {
  out.push(point[0], point[1], point[2]);
}

/** Emit a planar quad with the winding that makes `normal` its outward one. */
function quad(
  out: number[],
  normal: Vec3,
  corners: [Vec3, Vec3, Vec3, Vec3],
): void {
  const [a, b, c, d] = corners;
  const edge1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const edge2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const facing =
    (edge1[1] * edge2[2] - edge1[2] * edge2[1]) * normal[0] +
    (edge1[2] * edge2[0] - edge1[0] * edge2[2]) * normal[1] +
    (edge1[0] * edge2[1] - edge1[1] * edge2[0]) * normal[2];
  const ordered: Vec3[] = facing >= 0 ? [a, b, c, d] : [a, d, c, b];
  push(out, ordered[0]);
  push(out, ordered[1]);
  push(out, ordered[2]);
  push(out, ordered[0]);
  push(out, ordered[2]);
  push(out, ordered[3]);
}

/** Rectangle of the plane y = level, given its X and Z bounds. */
function topPatch(
  out: number[],
  level: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  normal: Vec3 = [0, 1, 0],
): void {
  if (x1 - x0 <= 0 || z1 - z0 <= 0) return;
  quad(out, normal, [
    [x0, level, z0],
    [x1, level, z0],
    [x1, level, z1],
    [x0, level, z1],
  ]);
}

export function slottedBlock(): TriangleMesh {
  const { length, height, width } = BLOCK;
  const out: number[] = [];
  // Bottom and the four sides.
  topPatch(out, 0, 0, length, 0, width, [0, -1, 0]);
  quad(
    out,
    [-1, 0, 0],
    [
      [0, 0, 0],
      [0, height, 0],
      [0, height, width],
      [0, 0, width],
    ],
  );
  quad(
    out,
    [1, 0, 0],
    [
      [length, 0, 0],
      [length, height, 0],
      [length, height, width],
      [length, 0, width],
    ],
  );
  quad(
    out,
    [0, 0, -1],
    [
      [0, 0, 0],
      [length, 0, 0],
      [length, height, 0],
      [0, height, 0],
    ],
  );
  quad(
    out,
    [0, 0, 1],
    [
      [0, 0, width],
      [length, 0, width],
      [length, height, width],
      [0, height, width],
    ],
  );
  // Top face, split around the slots.
  topPatch(out, height, 0, length, 0, SLOT.from);
  topPatch(out, height, 0, length, SLOT.to, width);
  let cursor = 0;
  for (const start of SLOT.starts) {
    topPatch(out, height, cursor, start, SLOT.from, SLOT.to);
    cursor = start + SLOT.width;
  }
  topPatch(out, height, cursor, length, SLOT.from, SLOT.to);
  // Slot floors and walls.
  const floor = height - SLOT.depth;
  for (const start of SLOT.starts) {
    const end = start + SLOT.width;
    topPatch(out, floor, start, end, SLOT.from, SLOT.to);
    quad(
      out,
      [1, 0, 0],
      [
        [start, floor, SLOT.from],
        [start, height, SLOT.from],
        [start, height, SLOT.to],
        [start, floor, SLOT.to],
      ],
    );
    quad(
      out,
      [-1, 0, 0],
      [
        [end, floor, SLOT.from],
        [end, height, SLOT.from],
        [end, height, SLOT.to],
        [end, floor, SLOT.to],
      ],
    );
    quad(
      out,
      [0, 0, 1],
      [
        [start, floor, SLOT.from],
        [end, floor, SLOT.from],
        [end, height, SLOT.from],
        [start, height, SLOT.from],
      ],
    );
    quad(
      out,
      [0, 0, -1],
      [
        [start, floor, SLOT.to],
        [end, floor, SLOT.to],
        [end, height, SLOT.to],
        [start, height, SLOT.to],
      ],
    );
  }
  return {
    positions: Float64Array.from(out),
    min: [0, 0, 0],
    max: [length, height, width],
  };
}
