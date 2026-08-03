import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertValidBlobKey, type BlobStore } from "./blob-store";
import { StoreConfigurationError } from "./model";

export interface S3BlobStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function resolveS3ConfigFromEnv(): S3BlobStoreConfig {
  const bucket = process.env.QUOTEREADY_S3_BUCKET || "";
  const accessKeyId = process.env.QUOTEREADY_S3_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.QUOTEREADY_S3_SECRET_ACCESS_KEY || "";
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new StoreConfigurationError(
      "QUOTEREADY_BLOB_DRIVER=s3 requires QUOTEREADY_S3_BUCKET, QUOTEREADY_S3_ACCESS_KEY_ID and QUOTEREADY_S3_SECRET_ACCESS_KEY.",
    );
  }
  return {
    bucket,
    region: process.env.QUOTEREADY_S3_REGION || "us-east-1",
    endpoint: process.env.QUOTEREADY_S3_ENDPOINT || undefined,
    accessKeyId,
    secretAccessKey,
    // Path-style addressing is what MinIO and most self-hosted S3 servers expect.
    forcePathStyle:
      (process.env.QUOTEREADY_S3_FORCE_PATH_STYLE || "true") !== "false",
  };
}

/** S3-compatible blob storage (AWS S3, MinIO, Cloudflare R2, Garage…). */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3BlobStoreConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertValidBlobKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidBlobKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidBlobKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
