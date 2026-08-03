import { NextResponse } from "next/server";

const DEFAULT_JSON_LIMIT = 32 * 1024;

export class RequestInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RequestInputError";
  }
}

function configuredOrigin(): string | null {
  const redirectUri = process.env.ZOO_OAUTH_REDIRECT_URI?.trim();
  if (!redirectUri) return null;
  try {
    return new URL(redirectUri).origin;
  } catch {
    return null;
  }
}

function forwardedOrigin(request: Request): string | null {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return null;
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwardedProtocol || new URL(request.url).protocol.replace(":", "");
  return `${protocol}://${host}`;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const allowed = new Set(
    [
      configuredOrigin(),
      forwardedOrigin(request),
      new URL(request.url).origin,
    ].filter((value): value is string => Boolean(value)),
  );
  if (!origin || !allowed.has(origin)) {
    throw new RequestInputError(
      "The request origin could not be verified.",
      403,
    );
  }
}

async function readRequestBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RequestInputError(
        "The request has an invalid Content-Length header.",
        400,
      );
    }
    if (length > maximumBytes) {
      throw new RequestInputError(
        "The request body exceeds the permitted size.",
        413,
      );
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        throw new RequestInputError(
          "The request body exceeds the permitted size.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readJsonObject(
  request: Request,
  maximumBytes = DEFAULT_JSON_LIMIT,
): Promise<Record<string, unknown>> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestInputError("Content-Type must be application/json.", 415);
  }
  const bytes = await readRequestBytes(request, maximumBytes);
  if (bytes.byteLength === 0)
    throw new RequestInputError("A JSON request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestInputError("The JSON request body is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestInputError("The JSON request body must be an object.");
  }
  return value as Record<string, unknown>;
}

export async function readResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new RequestInputError(
      "An upstream response exceeded its safety limit.",
      502,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("upstream response limit exceeded");
        throw new RequestInputError(
          "An upstream response exceeded its safety limit.",
          502,
        );
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

export function inputErrorResponse(
  error: unknown,
  fallback = "The request could not be processed.",
) {
  if (error instanceof RequestInputError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

interface RateBucket {
  count: number;
  resetsAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const activeKeys = new Set<string>();
const MAX_RATE_BUCKETS = 10_000;
let nextRateSweep = 0;

function maintainRateBuckets(now: number, windowMs: number): void {
  if (now < nextRateSweep && rateBuckets.size < MAX_RATE_BUCKETS) return;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetsAt <= now) rateBuckets.delete(key);
  }
  nextRateSweep = now + Math.min(windowMs, 60_000);
}

export function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): void {
  const now = Date.now();
  maintainRateBuckets(now, windowMs);
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetsAt <= now) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      throw new RequestInputError(
        "Request capacity is temporarily unavailable. Try again shortly.",
        503,
      );
    }
    rateBuckets.set(key, { count: 1, resetsAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new RequestInputError(
      "Too many requests. Wait before trying again.",
      429,
    );
  }
  bucket.count += 1;
}

export async function withSingleFlight<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeKeys.has(key)) {
    throw new RequestInputError(
      "An analysis is already running for this account.",
      409,
    );
  }
  activeKeys.add(key);
  try {
    return await operation();
  } finally {
    activeKeys.delete(key);
  }
}
