import type { ApiTrace, GeometryMetrics } from "@quoteredy/core/types";
import { readResponseText } from "@/lib/request-security";

const ZOO_API_BASE = "https://api.zoo.dev";
const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPTS = 18;
const ANALYSIS_DEADLINE_MS = 45_000;
const MAX_ZOO_RESPONSE_BYTES = 128 * 1024;

type ZooStatus = "queued" | "uploaded" | "in_progress" | "completed" | "failed";

interface ZooOperation {
  id?: string;
  status?: ZooStatus;
  error?: string | null;
  /** Zoo error bodies carry the human-readable reason in `message`. */
  message?: string | null;
  volume?: number | null;
  surface_area?: number | null;
  mass?: number | null;
  center_of_mass?: { x: number; y: number; z: number } | null;
}

interface MetricResult {
  data: ZooOperation | null;
  trace: ApiTrace;
}

class ZooApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ZooApiError";
  }
}

async function readJson(
  response: Response,
  endpoint: string,
): Promise<ZooOperation> {
  const text = await readResponseText(response, MAX_ZOO_RESPONSE_BYTES);
  let value: unknown;

  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ZooApiError(
      "Zoo returned an unreadable response.",
      endpoint,
      response.status,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ZooApiError(
      "Zoo returned an invalid operation response.",
      endpoint,
      response.status,
    );
  }
  const data = value as ZooOperation;

  if (!response.ok) {
    const detail =
      typeof data.error === "string" && data.error.trim()
        ? data.error
        : typeof data.message === "string" && data.message.trim()
          ? data.message
          : null;
    throw new ZooApiError(
      detail
        ? `HTTP ${response.status}: ${detail}`.slice(0, 300)
        : `Zoo request failed with HTTP ${response.status}.`,
      endpoint,
      response.status,
    );
  }

  for (const [label, metric] of [
    ["volume", data.volume],
    ["surface area", data.surface_area],
    ["mass", data.mass],
  ] as const) {
    if (
      metric !== undefined &&
      metric !== null &&
      (!Number.isFinite(metric) || metric < 0 || metric > 1e15)
    ) {
      throw new ZooApiError(
        `Zoo returned an invalid ${label} value.`,
        endpoint,
        response.status,
      );
    }
  }
  if (data.center_of_mass !== undefined && data.center_of_mass !== null) {
    const coordinates = [
      data.center_of_mass.x,
      data.center_of_mass.y,
      data.center_of_mass.z,
    ];
    if (
      coordinates.some(
        (coordinate) =>
          !Number.isFinite(coordinate) || Math.abs(coordinate) > 1e9,
      )
    ) {
      throw new ZooApiError(
        "Zoo returned an invalid centre-of-mass value.",
        endpoint,
        response.status,
      );
    }
  }

  return data;
}

function combinedSignal(deadline: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]);
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, POLL_INTERVAL_MS);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function pollOperation(
  operation: ZooOperation,
  token: string,
  endpoint: string,
  deadline: AbortSignal,
): Promise<ZooOperation> {
  if (!operation.id || !operation.status || operation.status === "completed") {
    return operation;
  }

  if (operation.status === "failed") {
    throw new ZooApiError(operation.error || "Zoo operation failed.", endpoint);
  }

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await waitForPoll(deadline);
    const response = await fetch(
      `${ZOO_API_BASE}/async/operations/${encodeURIComponent(operation.id)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: combinedSignal(deadline, 8_000),
      },
    );
    const current = await readJson(response, endpoint);

    if (current.status === "completed") return current;
    if (current.status === "failed") {
      throw new ZooApiError(current.error || "Zoo operation failed.", endpoint);
    }
  }

  throw new ZooApiError(
    "Zoo operation did not complete within the QuoteReady Studio timeout.",
    endpoint,
  );
}

async function runMetric(
  endpoint: string,
  file: ArrayBuffer,
  token: string,
  deadline: AbortSignal,
): Promise<MetricResult> {
  const startedAt = Date.now();

  try {
    const response = await fetch(`${ZOO_API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: file,
      cache: "no-store",
      signal: combinedSignal(deadline, 20_000),
    });
    const initial = await readJson(response, endpoint);
    const data = await pollOperation(initial, token, endpoint, deadline);

    return {
      data,
      trace: {
        endpoint,
        status: "completed",
        durationMs: Date.now() - startedAt,
        operationId: data.id,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Zoo API error";
    return {
      data: null,
      trace: {
        endpoint,
        status: "failed",
        durationMs: Date.now() - startedAt,
        detail: message,
      },
    };
  }
}

export async function analyzeWithZoo(input: {
  file: ArrayBuffer;
  format: string;
  densityKgM3: number | null;
  token: string;
}): Promise<{ metrics: GeometryMetrics; apiTrace: ApiTrace[] }> {
  const format = encodeURIComponent(input.format);
  const deadline = AbortSignal.timeout(ANALYSIS_DEADLINE_MS);
  const calls: Promise<MetricResult>[] = [
    runMetric(
      `/file/volume?src_format=${format}&output_unit=mm3`,
      input.file,
      input.token,
      deadline,
    ),
    runMetric(
      `/file/surface-area?src_format=${format}&output_unit=mm2`,
      input.file,
      input.token,
      deadline,
    ),
    runMetric(
      `/file/center-of-mass?src_format=${format}&output_unit=mm`,
      input.file,
      input.token,
      deadline,
    ),
  ];

  if (input.densityKgM3 !== null) {
    calls.push(
      runMetric(
        `/file/mass?src_format=${format}&material_density=${input.densityKgM3}&material_density_unit=kg%3Am3&output_unit=g`,
        input.file,
        input.token,
        deadline,
      ),
    );
  }

  const [volume, surfaceArea, centerOfMass, mass] = await Promise.all(calls);
  const center = centerOfMass.data?.center_of_mass;

  return {
    metrics: {
      volumeMm3: volume.data?.volume ?? null,
      surfaceAreaMm2: surfaceArea.data?.surface_area ?? null,
      centerOfMassMm: center ? [center.x, center.y, center.z] : null,
      massG: mass?.data?.mass ?? null,
    },
    apiTrace: [
      volume.trace,
      surfaceArea.trace,
      centerOfMass.trace,
      ...(mass ? [mass.trace] : []),
    ],
  };
}
