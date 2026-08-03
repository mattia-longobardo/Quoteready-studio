import { isManufacturingProcess } from "@quoteredy/core/manufacturing";
import { isMaterialId } from "@quoteredy/core/materials";
import { RequestInputError } from "@/lib/request-security";
import type { RfqMetadata } from "@quoteredy/core/types";

const FORMAT_BY_EXTENSION: Record<string, string> = {
  step: "step",
  stp: "step",
  stl: "stl",
  obj: "obj",
  ply: "ply",
  sldprt: "sldprt",
  ipt: "inventor",
  sat: "acis",
  x_t: "parasolid",
  x_b: "parasolid",
};

const ALLOWED_METADATA_FIELDS = new Set([
  "partName",
  "process",
  "material",
  "quantity",
  "units",
  "tolerance",
  "finish",
  "notes",
  "sourceProjectId",
  "sourceProjectName",
]);

interface FileContent {
  bytes: Uint8Array;
  size: number;
}

function stringField(
  input: Record<string, unknown>,
  name: string,
  maximumLength: number,
  fallback = "",
): string {
  const raw = input[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string")
    throw new RequestInputError(`${name} must be text.`);
  const value = raw.trim();
  if (value.length > maximumLength) {
    throw new RequestInputError(
      `${name} cannot exceed ${maximumLength} characters.`,
    );
  }
  return value;
}

/** Finish assumed when the customer supplies none. */
const DEFAULT_FINISH = "As Machined";
/** General tolerance assumed when the customer supplies none. */
const DEFAULT_TOLERANCE = "ISO 2768-m";

export function parseRfqMetadata(
  input: Record<string, unknown>,
  hasDrawing: boolean,
  options: { requireComplete?: boolean } = {},
): RfqMetadata {
  for (const name of Object.keys(input)) {
    if (!ALLOWED_METADATA_FIELDS.has(name)) {
      throw new RequestInputError(`Unsupported RFQ field: ${name}.`);
    }
  }
  const process = stringField(input, "process", 40, "unknown");
  const material = stringField(input, "material", 40, "unknown");
  const units = stringField(input, "units", 16, "unknown");
  if (!isManufacturingProcess(process))
    throw new RequestInputError("Select a supported target process.");
  if (!isMaterialId(material))
    throw new RequestInputError("Select a supported material.");
  if (!["unknown", "mm", "in"].includes(units))
    throw new RequestInputError("Select supported design units.");

  const quantityRaw = input.quantity;
  let quantity: number | null = null;
  if (quantityRaw !== undefined && quantityRaw !== null && quantityRaw !== "") {
    quantity = Number(quantityRaw);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 1_000_000
    ) {
      throw new RequestInputError(
        "Quantity must be a whole number from 1 to 1,000,000.",
      );
    }
  }

  const sourceProjectId = stringField(input, "sourceProjectId", 200);
  const sourceProjectName = stringField(input, "sourceProjectName", 160);
  if (Boolean(sourceProjectId) !== Boolean(sourceProjectName)) {
    throw new RequestInputError(
      "Zoo project identity must include both ID and name.",
    );
  }

  const metadata: RfqMetadata = {
    partName: stringField(input, "partName", 140),
    process,
    material,
    quantity,
    units,
    // Empty tolerance/finish → assume the industry defaults instead of
    // failing the readiness check later.
    tolerance: stringField(input, "tolerance", 160) || DEFAULT_TOLERANCE,
    finish: stringField(input, "finish", 160) || DEFAULT_FINISH,
    notes: stringField(input, "notes", 2_000),
    hasDrawing,
    sourceProject: sourceProjectId
      ? { id: sourceProjectId, name: sourceProjectName }
      : undefined,
  };

  // Live analyses refuse to start with an incomplete package: missing
  // parameters must be fixed up front, not discovered as failures afterwards.
  if (options.requireComplete) {
    const missing: string[] = [];
    if (!metadata.partName) missing.push("part name");
    if (metadata.material === "unknown") missing.push("material");
    if (metadata.units === "unknown") missing.push("design units");
    if (!metadata.quantity) missing.push("quantity");
    if (missing.length > 0) {
      throw new RequestInputError(
        `The manufacturing plan cannot start: complete ${missing.join(", ")} first. Target process, tolerance and finish are optional (defaults: "${DEFAULT_TOLERANCE}", "${DEFAULT_FINISH}").`,
      );
    }
  }
  return metadata;
}

export function getCadFormat(filename: string): string | null {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

export function isValidDrawingContent(file: FileContent): boolean {
  return (
    hasPrefix(file.bytes, [0x25, 0x50, 0x44, 0x46]) ||
    hasPrefix(file.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    hasPrefix(file.bytes, [0xff, 0xd8, 0xff])
  );
}

export function isValidCadContent(file: FileContent, format: string): boolean {
  if (
    isValidDrawingContent(file) ||
    (hasPrefix(file.bytes, [0x50, 0x4b, 0x03, 0x04]) &&
      format !== "sldprt" &&
      format !== "inventor")
  ) {
    return false;
  }
  const start = new TextDecoder()
    .decode(file.bytes.slice(0, 4_096))
    .trimStart();
  if (format === "step") return start.includes("ISO-10303-21");
  if (format === "ply") return start.startsWith("ply");
  if (format === "obj") return /^(?:#.*\n)*(?:o|g|v|vt|vn|f)\s/m.test(start);
  if (format === "stl")
    return file.size >= 84 || start.toLowerCase().startsWith("solid");
  return true;
}
