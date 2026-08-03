import path from "node:path";

import { StoreConfigurationError } from "./model";

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

/** Reject traversal and control characters before a key reaches any backend. */
export function assertValidBlobKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.endsWith("/")) {
    throw new StoreConfigurationError(`Invalid blob key: ${key}`);
  }
}

export function sanitizeBlobFileName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return (base || "file").slice(0, 120);
}

export type BlobDriverName = "fs" | "s3";
