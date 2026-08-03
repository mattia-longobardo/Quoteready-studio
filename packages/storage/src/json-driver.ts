import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  emptyWorkspace,
  isRecord,
  STORE_LIMITS,
  StoreQuotaError,
  validateWorkspaceShape,
  type UserWorkspace,
  type WorkspaceStoreDriver,
} from "./model";

interface StoreData {
  version: 1;
  users: Record<string, UserWorkspace>;
}

function validateStore(value: unknown): StoreData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.users)) {
    throw new Error(
      "The workspace store has an unsupported or invalid structure.",
    );
  }
  for (const workspace of Object.values(value.users)) {
    validateWorkspaceShape(workspace);
  }
  return value as unknown as StoreData;
}

/**
 * Single-file JSON persistence with atomic rename. Suitable for one process;
 * multi-replica deployments must use the Postgres driver instead.
 */
export class JsonWorkspaceDriver implements WorkspaceStoreDriver {
  private readonly storePath: string;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.storePath = path.join(dataDir, "platform.json");
  }

  private async readStore(): Promise<StoreData> {
    try {
      const bytes = await readFile(this.storePath);
      if (bytes.byteLength > STORE_LIMITS.maximumBytes) {
        throw new Error(
          "The workspace store exceeds its configured safety limit.",
        );
      }
      return validateStore(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, users: {} };
    }
  }

  private async writeStore(data: StoreData): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized) > STORE_LIMITS.maximumBytes) {
      throw new StoreQuotaError(
        "The workspace has reached its storage safety limit.",
      );
    }
    await mkdir(this.dataDir, { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, serialized, { mode: 0o600 });
    await rename(temporaryPath, this.storePath);
  }

  async read(userId: string): Promise<UserWorkspace | null> {
    await this.mutationQueue;
    const store = await this.readStore();
    return store.users[userId] ?? null;
  }

  mutate<T>(
    userId: string,
    operation: (workspace: UserWorkspace) => T | Promise<T>,
  ): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      const store = await this.readStore();
      const workspace = store.users[userId] ?? emptyWorkspace();
      store.users[userId] = workspace;
      const value = await operation(workspace);
      await this.writeStore(store);
      return value;
    });
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }
}
