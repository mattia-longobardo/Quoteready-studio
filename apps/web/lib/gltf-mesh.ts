/**
 * Dependency-free glTF 2.0 reader used by the drawing exporter: it turns the
 * part model archived by {@link storePartModel} into the triangle soup the
 * technical-view projector needs. Only the subset Zoo's conversion endpoint
 * emits is supported (float POSITION accessors, optional indices, node
 * transforms, embedded/GLB buffers) — enough to draw the part, without
 * pulling a full glTF stack into the server bundle.
 */

export type Vec3 = [number, number, number];

export interface TriangleMesh {
  /** Triangle corners in millimetres: 9 floats (3 vertices) per triangle. */
  positions: Float64Array;
  min: Vec3;
  max: Vec3;
}

/** glTF distances are metres by specification; drawings are dimensioned in mm. */
const MM_PER_UNIT = 1000;
/**
 * Guard against pathological tessellations eating the request's memory. A
 * model above the cap is rejected rather than truncated: half a part is worse
 * than a sheet that states no views could be projected.
 */
const MAX_TRIANGLES = 250_000;
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;
const MODE_TRIANGLES = 4;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfDocument {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength?: number }[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
}

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4×4 product, matching the glTF matrix layout. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return node.matrix.slice();
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/** Split a GLB container into its JSON document and binary chunk. */
function readGlb(bytes: Uint8Array): { json: string; bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let json = "";
  let bin: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.byteLength) break;
    if (type === GLB_CHUNK_JSON) {
      json = Buffer.from(bytes.subarray(start, end)).toString("utf8");
    } else if (type === GLB_CHUNK_BIN) {
      bin = bytes.subarray(start, end);
    }
    offset = end + ((4 - (length % 4)) % 4);
  }
  return { json, bin };
}

function decodeBuffer(uri: string | undefined, bin: Uint8Array | null) {
  if (!uri) return bin;
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) return null;
  return new Uint8Array(Buffer.from(uri.slice(comma + 1), "base64"));
}

/** Read an accessor as a flat array of its numeric components. */
function readAccessor(
  document: GltfDocument,
  buffers: (Uint8Array | null)[],
  index: number,
): Float64Array | null {
  const accessor = document.accessors?.[index];
  if (!accessor) return null;
  const components = TYPE_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!components || !componentBytes || accessor.bufferView === undefined) {
    return null;
  }
  const bufferView = document.bufferViews?.[accessor.bufferView];
  if (!bufferView) return null;
  const buffer = buffers[bufferView.buffer];
  if (!buffer) return null;
  const stride = bufferView.byteStride || components * componentBytes;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const out = new Float64Array(accessor.count * components);
  for (let element = 0; element < accessor.count; element += 1) {
    const start = base + element * stride;
    for (let component = 0; component < components; component += 1) {
      const at = start + component * componentBytes;
      if (at + componentBytes > buffer.byteLength) return null;
      let value: number;
      switch (accessor.componentType) {
        case 5120:
          value = view.getInt8(at);
          break;
        case 5121:
          value = view.getUint8(at);
          break;
        case 5122:
          value = view.getInt16(at, true);
          break;
        case 5123:
          value = view.getUint16(at, true);
          break;
        case 5125:
          value = view.getUint32(at, true);
          break;
        default:
          value = view.getFloat32(at, true);
      }
      out[element * components + component] = value;
    }
  }
  return out;
}

/**
 * Parse a glTF/GLB model into a millimetre triangle mesh. Returns null when
 * the file cannot be read or carries no triangles, so callers can degrade to a
 * drawing sheet without views instead of failing the export.
 */
export function parseGltfMesh(bytes: Uint8Array): TriangleMesh | null {
  let json = "";
  let bin: Uint8Array | null = null;
  if (
    bytes.byteLength >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) ===
      GLB_MAGIC
  ) {
    ({ json, bin } = readGlb(bytes));
  } else {
    json = Buffer.from(bytes).toString("utf8");
  }
  let document: GltfDocument;
  try {
    document = JSON.parse(json) as GltfDocument;
  } catch {
    return null;
  }
  if (!document.meshes?.length) return null;

  const buffers = (document.buffers ?? []).map((buffer) =>
    decodeBuffer(buffer.uri, bin),
  );
  const positions: number[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let tooLarge = false;

  const emit = (matrix: Mat4, meshIndex: number): void => {
    const mesh = document.meshes?.[meshIndex];
    for (const primitive of mesh?.primitives ?? []) {
      if ((primitive.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex === undefined) continue;
      const source = readAccessor(document, buffers, positionIndex);
      if (!source) continue;
      const indices =
        primitive.indices === undefined
          ? null
          : readAccessor(document, buffers, primitive.indices);
      const count = indices ? indices.length : source.length / 3;
      for (let corner = 0; corner + 2 < count; corner += 3) {
        if (triangles >= MAX_TRIANGLES) {
          tooLarge = true;
          return;
        }
        triangles += 1;
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const at = indices ? indices[corner + vertex] : corner + vertex;
          const point = transformPoint(
            matrix,
            source[at * 3],
            source[at * 3 + 1],
            source[at * 3 + 2],
          );
          for (let axis = 0; axis < 3; axis += 1) {
            const value = point[axis] * MM_PER_UNIT;
            positions.push(value);
            if (value < min[axis]) min[axis] = value;
            if (value > max[axis]) max[axis] = value;
          }
        }
      }
    }
  };

  const visited = new Set<number>();
  const walk = (nodeIndex: number, parent: Mat4): void => {
    if (visited.has(nodeIndex)) return;
    visited.add(nodeIndex);
    const node = document.nodes?.[nodeIndex];
    if (!node) return;
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emit(matrix, node.mesh);
    for (const child of node.children ?? []) walk(child, matrix);
  };

  const roots =
    document.scenes?.[document.scene ?? 0]?.nodes ??
    (document.nodes ?? []).map((_, index) => index);
  for (const root of roots) walk(root, IDENTITY);
  // Models without a scene graph still carry their meshes; draw them anyway.
  if (positions.length === 0) {
    for (let index = 0; index < (document.meshes?.length ?? 0); index += 1) {
      emit(IDENTITY, index);
    }
  }
  if (tooLarge || positions.length < 9) return null;
  return { positions: Float64Array.from(positions), min, max };
}
