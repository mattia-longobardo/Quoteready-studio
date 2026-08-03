import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertValidBlobKey, type BlobStore } from "./blob-store";

/** Filesystem blob storage under <dataDir>/blobs, written atomically. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  private resolvePath(key: string): string {
    assertValidBlobKey(key);
    const target = path.join(this.baseDir, key);
    const relative = path.relative(this.baseDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Blob key escapes the storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolvePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}
