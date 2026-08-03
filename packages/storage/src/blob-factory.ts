import path from "node:path";

import { type BlobDriverName, type BlobStore } from "./blob-store";
import { FsBlobStore } from "./fs-blob-store";
import { StoreConfigurationError } from "./model";
import { resolveS3ConfigFromEnv, S3BlobStore } from "./s3-blob-store";
import { resolveDataDir } from "./workspace-store";

const blobCache = new Map<string, BlobStore>();

/**
 * Environment-driven blob store factory: QUOTEREADY_BLOB_DRIVER=fs (default)
 * stores under <dataDir>/blobs; =s3 targets any S3-compatible endpoint.
 */
export function getBlobStore(): BlobStore {
  const name = (
    process.env.QUOTEREADY_BLOB_DRIVER || "fs"
  ).toLowerCase() as BlobDriverName;
  if (name === "s3") {
    const config = resolveS3ConfigFromEnv();
    const key = `s3:${config.endpoint ?? "aws"}:${config.bucket}`;
    const cached = blobCache.get(key);
    if (cached) return cached;
    const store = new S3BlobStore(config);
    blobCache.set(key, store);
    return store;
  }
  if (name !== "fs") {
    throw new StoreConfigurationError(
      `Unknown QUOTEREADY_BLOB_DRIVER value: ${name}. Use "fs" or "s3".`,
    );
  }
  const baseDir = path.join(resolveDataDir(), "blobs");
  const key = `fs:${baseDir}`;
  const cached = blobCache.get(key);
  if (cached) return cached;
  const store = new FsBlobStore(baseDir);
  blobCache.set(key, store);
  return store;
}
