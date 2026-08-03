import { getBlobStore, sanitizeBlobFileName } from "@quoteredy/storage";

import { readResponseText } from "@/lib/request-security";

const ZOO_API_BASE = "https://api.zoo.dev";
// glTF with embedded buffers is JSON with base64 payloads, so responses are
// much larger than the source CAD file.
const MAX_CONVERSION_RESPONSE_BYTES = 48 * 1024 * 1024;
const CONVERSION_DEADLINE_MS = 45_000;
const CONVERSION_POLL_INTERVAL_MS = 1_000;

export const GLTF_CONTENT_TYPE = "model/gltf+json";

/** CAD formats Zoo's conversion endpoint accepts as a source. */
const CONVERTIBLE_FORMATS = new Set([
  "fbx",
  "obj",
  "ply",
  "sldprt",
  "step",
  "stl",
]);

function isConvertibleCadFormat(format: string): boolean {
  return CONVERTIBLE_FORMATS.has(format);
}

function partModelBlobKey(userId: string, partId: string): string {
  return [
    "users",
    sanitizeBlobFileName(userId),
    "parts",
    sanitizeBlobFileName(partId),
    "model.gltf",
  ].join("/");
}

interface ConversionOperation {
  id?: string;
  status?: string;
  error?: string | null;
  message?: string | null;
  outputs?: Record<string, unknown>;
}

function firstOutput(operation: ConversionOperation): Uint8Array | null {
  if (!operation.outputs || typeof operation.outputs !== "object") return null;
  for (const value of Object.values(operation.outputs)) {
    if (typeof value === "string" && value) {
      return new Uint8Array(Buffer.from(value, "base64"));
    }
  }
  return null;
}

async function readOperation(response: Response): Promise<ConversionOperation> {
  const text = await readResponseText(response, MAX_CONVERSION_RESPONSE_BYTES);
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as ConversionOperation;
    }
  } catch {
    // Fall through to the empty operation; the caller reports the failure.
  }
  return {};
}

function operationError(
  operation: ConversionOperation,
  fallback: string,
): string {
  const detail = operation.error ?? operation.message;
  return typeof detail === "string" && detail.trim()
    ? detail.slice(0, 300)
    : fallback;
}

/**
 * Convert a CAD file to embedded glTF via Zoo's file conversion API so the
 * platform can render an interactive preview. Conversions above Zoo's inline
 * size threshold complete asynchronously and are polled until done.
 */
async function convertCadToGltf(input: {
  file: ArrayBuffer;
  format: string;
  token: string;
}): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(CONVERSION_DEADLINE_MS);
  const response = await fetch(
    `${ZOO_API_BASE}/file/conversion/${encodeURIComponent(input.format)}/gltf`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: input.file,
      cache: "no-store",
      signal: deadline,
    },
  );
  let operation = await readOperation(response);
  if (!response.ok) {
    throw new Error(
      operationError(
        operation,
        `Zoo file conversion failed (HTTP ${response.status}).`,
      ),
    );
  }

  while (operation.status !== "completed") {
    if (operation.status === "failed") {
      throw new Error(
        operationError(operation, "Zoo could not convert the CAD file."),
      );
    }
    const id = typeof operation.id === "string" ? operation.id : "";
    if (!id) throw new Error("Zoo returned an invalid conversion operation.");
    await new Promise((resolve) =>
      setTimeout(resolve, CONVERSION_POLL_INTERVAL_MS),
    );
    if (deadline.aborted) throw new Error("Zoo file conversion timed out.");
    const poll = await fetch(
      `${ZOO_API_BASE}/async/operations/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${input.token}` },
        cache: "no-store",
        signal: deadline,
      },
    );
    operation = await readOperation(poll);
    if (!poll.ok) {
      throw new Error(
        operationError(
          operation,
          `Zoo conversion polling failed (HTTP ${poll.status}).`,
        ),
      );
    }
  }

  const bytes = firstOutput(operation);
  if (!bytes) throw new Error("Zoo returned an empty glTF conversion.");
  return bytes;
}

/**
 * Best-effort: convert the uploaded CAD file and archive the glTF next to the
 * part so the Parts view can render a 3D preview. Returns the blob key, or
 * null when the preview could not be produced (never throws).
 */
export async function storePartModel(input: {
  userId: string;
  partId: string;
  file: ArrayBuffer;
  format: string;
  token: string;
}): Promise<string | null> {
  if (!isConvertibleCadFormat(input.format)) return null;
  try {
    const bytes = await convertCadToGltf(input);
    const key = partModelBlobKey(input.userId, input.partId);
    await getBlobStore().put(key, bytes, GLTF_CONTENT_TYPE);
    return key;
  } catch (error) {
    console.warn(
      `Part model preview failed for part ${input.partId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
