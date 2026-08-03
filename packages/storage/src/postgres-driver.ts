import { Pool } from "pg";

import {
  emptyWorkspace,
  STORE_LIMITS,
  StoreQuotaError,
  validateWorkspaceShape,
  type UserWorkspace,
  type WorkspaceStoreDriver,
} from "./model";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quoteready_workspaces (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * One JSONB document per user, mutated under a row lock so the domain
 * invariants stay identical to the JSON driver while supporting multiple
 * application replicas.
 */
export class PostgresWorkspaceDriver implements WorkspaceStoreDriver {
  private readonly pool: Pool;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
  }

  private async init(): Promise<void> {
    this.ready ??= this.pool.query(SCHEMA_SQL).then(() => undefined);
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async read(userId: string): Promise<UserWorkspace | null> {
    await this.init();
    const result = await this.pool.query(
      "SELECT data FROM quoteready_workspaces WHERE user_id = $1",
      [userId],
    );
    if (result.rows.length === 0) return null;
    return validateWorkspaceShape(result.rows[0].data);
  }

  async mutate<T>(
    userId: string,
    operation: (workspace: UserWorkspace) => T | Promise<T>,
  ): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT data FROM quoteready_workspaces WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const workspace =
        current.rows.length > 0
          ? validateWorkspaceShape(current.rows[0].data)
          : emptyWorkspace();
      const value = await operation(workspace);
      const serialized = JSON.stringify(workspace);
      if (Buffer.byteLength(serialized) > STORE_LIMITS.maximumBytes) {
        throw new StoreQuotaError(
          "The workspace has reached its storage safety limit.",
        );
      }
      await client.query(
        `INSERT INTO quoteready_workspaces (user_id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [userId, serialized],
      );
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
