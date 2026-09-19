/**
 * Minimal SQL executor abstraction — the portability seam.
 * Domain code depends only on these interfaces, never on `pg` or Supabase.
 * Only postgres.ts knows about the wire driver; swapping to another
 * Postgres driver (or plain Postgres on a VPS) means re-implementing this
 * file's factory, not the repositories.
 */

export type SqlParams = unknown[];

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** Query-only handle. Repositories take this so they compose inside or outside a tx. */
export interface DbExecutor {
  query<T = Record<string, unknown>>(text: string, params?: SqlParams): Promise<SqlResult<T>>;
}

/** Transaction handle (same query surface; commit/rollback owned by withTransaction). */
export type DbTx = DbExecutor;

/** Connection source with explicit transaction boundaries. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: SqlParams): Promise<SqlResult<T>>;
  /**
   * Run fn inside a single transaction (commit on success, rollback on throw).
   * Do NOT nest withTransaction calls on a pool-backed Db: the inner call
   * would wait for a second connection while holding the first — with a small
   * pool this deadlocks. Compose nested logic on the passed tx instead.
   */
  withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------- domain-mapped errors (driver-agnostic) ----------

/** UNIQUE violation (identity taken, duplicate request/idempotency key, ...). */
export class DbConflictError extends Error {
  readonly code = "DB_CONFLICT";
  constructor(message = "Unique constraint violated") {
    super(message);
    this.name = "DbConflictError";
  }
}

/** CHECK violation (negative balance, negative cost, ...). */
export class DbCheckError extends Error {
  readonly code = "DB_CHECK";
  constructor(message = "Check constraint violated") {
    super(message);
    this.name = "DbCheckError";
  }
}

/** Foreign-key violation (dangling user/app/operation reference). */
export class DbForeignKeyError extends Error {
  readonly code = "DB_FOREIGN_KEY";
  constructor(message = "Foreign key violated") {
    super(message);
    this.name = "DbForeignKeyError";
  }
}
