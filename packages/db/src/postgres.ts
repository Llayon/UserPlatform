/**
 * PostgreSQL adapter (works against Supabase Postgres via DATABASE_URL).
 * This is the ONLY file allowed to import the `pg` driver. Everything else
 * depends on DbExecutor/Db. Row mapping (snake_case → camelCase) and
 * driver-error mapping (pg codes → DbConflict/Check/ForeignKey) live here.
 */
import { Pool, type PoolClient } from "pg";
import {
  DbCheckError,
  DbConflictError,
  DbForeignKeyError,
  type Db,
  type DbExecutor,
  type DbTx,
  type SqlParams,
  type SqlResult,
} from "./executor.js";
import type {
  DbApp,
  DbAcquisition,
  DbEntitlement,
  DbIdentity,
  DbLedgerEntry,
  DbOperation,
  DbProfile,
  DbReservation,
  DbSession,
  DbUsageEvent,
  DbUser,
  DbWallet,
  IdentityProvider,
  ReservationStatus,
  UsageStatus,
  UserStatus,
  AppStatus,
} from "./types.js";
import type {
  EntitlementsRepo,
  AcquisitionsRepo,
  IdentitiesRepo,
  LedgerRepo,
  ProfilesRepo,
  RegistryRepo,
  Repos,
  ReservationsRepo,
  SessionsRepo,
  UsageRepo,
  UsersRepo,
  WalletsRepo,
} from "./repos.js";

interface PgError {
  code?: string;
  message: string;
}

function mapPgError(err: unknown): Error {
  const pg = err as PgError;
  if (pg && typeof pg.code === "string") {
    if (pg.code === "23505") return new DbConflictError(pg.message);
    if (pg.code === "23514") return new DbCheckError(pg.message);
    if (pg.code === "23503") return new DbForeignKeyError(pg.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

class PgExecutor implements DbExecutor {
  constructor(private readonly run: (text: string, params?: SqlParams) => Promise<SqlResult>) {}
  async query<T = Record<string, unknown>>(
    text: string,
    params?: SqlParams,
  ): Promise<SqlResult<T>> {
    try {
      return (await this.run(text, params)) as SqlResult<T>;
    } catch (err) {
      throw mapPgError(err);
    }
  }
}

export interface PgDbOptions {
  maxConnections?: number;
  statementTimeoutMs?: number;
}

export function createPgDb(databaseUrl: string, opts: PgDbOptions = {}): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.maxConnections ?? 5,
    statement_timeout: opts.statementTimeoutMs,
  });
  const root: DbExecutor = new PgExecutor(async (text, params) => {
    const res = await pool.query(text, (params ?? []) as unknown[]);
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
  });
  return {
    query: (text, params) => root.query(text, params),
    async withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: DbTx = new PgExecutor(async (text, params) => {
          try {
            const res = await client.query(text, (params ?? []) as unknown[]);
            return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
          } catch (err) {
            throw mapPgError(err);
          }
        });
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Rollback failure must not mask the original error.
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// ---------- row mapping ----------

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function str(v: unknown): string {
  return String(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function bool(v: unknown): boolean {
  return v === true;
}

type R = Record<string, unknown>;

function mapUser(r: R): DbUser {
  return {
    id: str(r.id),
    status: r.status as UserStatus,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function mapIdentity(r: R): DbIdentity {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    provider: r.provider as IdentityProvider,
    providerUserId: str(r.provider_user_id),
    providerUsername: strOrNull(r.provider_username),
    createdAt: iso(r.created_at),
    lastSeenAt: iso(r.last_seen_at),
  };
}
function mapProfile(r: R): DbProfile {
  return {
    userId: str(r.user_id),
    displayName: str(r.display_name),
    avatarUrl: strOrNull(r.avatar_url),
    locale: strOrNull(r.locale),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function mapSession(r: R): DbSession {
  return {
    tokenHash: str(r.token_hash),
    userId: str(r.user_id),
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}
function mapApp(r: R): DbApp {
  return {
    id: str(r.id),
    slug: str(r.slug),
    displayName: str(r.display_name),
    status: r.status as AppStatus,
    createdAt: iso(r.created_at),
  };
}
function mapOperation(r: R): DbOperation {
  return {
    id: str(r.id),
    appId: str(r.app_id),
    operationKey: str(r.operation_key),
    creditCost: num(r.credit_cost),
    enabled: bool(r.enabled),
    createdAt: iso(r.created_at),
  };
}
function mapWallet(r: R): DbWallet {
  return {
    userId: str(r.user_id),
    availableBalance: num(r.available_balance),
    reservedBalance: num(r.reserved_balance),
    version: num(r.version),
    updatedAt: iso(r.updated_at),
  };
}
function mapReservation(r: R): DbReservation {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    operationId: strOrNull(r.operation_id),
    amount: num(r.amount),
    status: r.status as ReservationStatus,
    requestId: str(r.request_id),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function mapLedger(r: R): DbLedgerEntry {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    delta: num(r.delta),
    balanceAfter: num(r.balance_after),
    appId: strOrNull(r.app_id),
    operationId: strOrNull(r.operation_id),
    reservationId: strOrNull(r.reservation_id),
    reason: str(r.reason),
    idempotencyKey: str(r.idempotency_key),
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: iso(r.created_at),
  };
}
function mapUsage(r: R): DbUsageEvent {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    appId: strOrNull(r.app_id),
    operation: str(r.operation),
    requestId: str(r.request_id),
    status: r.status as UsageStatus,
    latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : num(r.latency_ms),
    createdAt: iso(r.created_at),
  };
}
function mapEntitlement(r: R): DbEntitlement {
  return { userId: str(r.user_id), key: str(r.key), createdAt: iso(r.created_at) };
}

function mapAcquisition(r: R): DbAcquisition {
  return {
    userId: str(r.user_id),
    provider: r.provider as IdentityProvider,
    startParam: str(r.start_param),
    firstSeenAt: iso(r.first_seen_at),
  };
}

// ---------- repositories ----------

const users: UsersRepo = {
  async create(exec, input) {
    const { rows } = await exec.query<R>(`insert into users (status) values ($1) returning *`, [
      input?.status ?? "active",
    ]);
    return mapUser(rows[0]);
  },
  async getById(exec, id) {
    const { rows } = await exec.query<R>(`select * from users where id = $1`, [id]);
    return rows.length ? mapUser(rows[0]) : null;
  },
  async deleteById(exec, id) {
    await exec.query(`delete from users where id = $1`, [id]);
  },
};

const identities: IdentitiesRepo = {
  async create(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into user_identities (user_id, provider, provider_user_id, provider_username)
       values ($1, $2, $3, $4) returning *`,
      [input.userId, input.provider, input.providerUserId, input.providerUsername ?? null],
    );
    return mapIdentity(rows[0]);
  },
  async findByProvider(exec, provider, providerUserId) {
    const { rows } = await exec.query<R>(
      `select * from user_identities where provider = $1 and provider_user_id = $2`,
      [provider, providerUserId],
    );
    return rows.length ? mapIdentity(rows[0]) : null;
  },
  async touchLastSeen(exec, id, atIso) {
    await exec.query(`update user_identities set last_seen_at = $2 where id = $1`, [
      id,
      atIso ?? new Date().toISOString(),
    ]);
  },
};

const profiles: ProfilesRepo = {
  async create(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into profiles (user_id, display_name, avatar_url, locale)
       values ($1, $2, $3, $4) returning *`,
      [input.userId, input.displayName ?? "", input.avatarUrl ?? null, input.locale ?? null],
    );
    return mapProfile(rows[0]);
  },
  async getByUserId(exec, userId) {
    const { rows } = await exec.query<R>(`select * from profiles where user_id = $1`, [userId]);
    return rows.length ? mapProfile(rows[0]) : null;
  },
};

const sessions: SessionsRepo = {
  async create(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3) returning *`,
      [input.tokenHash, input.userId, input.expiresAt],
    );
    return mapSession(rows[0]);
  },
  async getByTokenHash(exec, tokenHash) {
    const { rows } = await exec.query<R>(`select * from sessions where token_hash = $1`, [
      tokenHash,
    ]);
    return rows.length ? mapSession(rows[0]) : null;
  },
  async deleteByTokenHash(exec, tokenHash) {
    await exec.query(`delete from sessions where token_hash = $1`, [tokenHash]);
  },
  async deleteExpired(exec, nowIso) {
    const { rowCount } = await exec.query(`delete from sessions where expires_at < $1`, [
      nowIso ?? new Date().toISOString(),
    ]);
    return rowCount;
  },
};

const registry: RegistryRepo = {
  async listApps(exec) {
    const { rows } = await exec.query<R>(`select * from apps order by slug`);
    return rows.map(mapApp);
  },
  async listOperations(exec) {
    const { rows } = await exec.query<R>(`select * from operations order by operation_key`);
    return rows.map(mapOperation);
  },
  async findOperationByKey(exec, fullKey) {
    const { rows } = await exec.query<R>(`select * from operations where operation_key = $1`, [
      fullKey,
    ]);
    return rows.length ? mapOperation(rows[0]) : null;
  },
  async getOperationById(exec, id) {
    const { rows } = await exec.query<R>(`select * from operations where id = $1`, [id]);
    return rows.length ? mapOperation(rows[0]) : null;
  },
};

const wallets: WalletsRepo = {
  async create(exec, userId) {
    const { rows } = await exec.query<R>(
      `insert into credit_wallets (user_id) values ($1) returning *`,
      [userId],
    );
    return mapWallet(rows[0]);
  },
  async getByUserId(exec, userId) {
    const { rows } = await exec.query<R>(`select * from credit_wallets where user_id = $1`, [
      userId,
    ]);
    return rows.length ? mapWallet(rows[0]) : null;
  },
  async tryReserve(exec, userId, amount) {
    if (!Number.isInteger(amount) || amount < 0)
      throw new Error(`Invalid reserve amount ${amount}`);
    const { rows } = await exec.query<R>(
      `update credit_wallets
       set available_balance = available_balance - $2,
           reserved_balance = reserved_balance + $2,
           version = version + 1,
           updated_at = now()
       where user_id = $1 and available_balance >= $2
       returning *`,
      [userId, amount],
    );
    return rows.length ? mapWallet(rows[0]) : null;
  },
  async adjust(exec, userId, delta) {
    const { rows } = await exec.query<R>(
      `update credit_wallets
       set available_balance = available_balance + $2,
           reserved_balance = reserved_balance + $3,
           version = version + 1,
           updated_at = now()
       where user_id = $1 and ($4::int is null or version = $4)
       returning *`,
      [userId, delta.available ?? 0, delta.reserved ?? 0, delta.expectedVersion ?? null],
    );
    return rows.length ? mapWallet(rows[0]) : null;
  },
};

const ledger: LedgerRepo = {
  async append(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into credit_ledger
         (user_id, delta, balance_after, app_id, operation_id, reservation_id, reason, idempotency_key, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.userId,
        input.delta,
        input.balanceAfter,
        input.appId ?? null,
        input.operationId ?? null,
        input.reservationId ?? null,
        input.reason,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapLedger(rows[0]);
  },
  async listByUser(exec, userId, limit = 50) {
    const { rows } = await exec.query<R>(
      `select * from credit_ledger where user_id = $1 order by created_at desc limit $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(mapLedger);
  },
};

const reservations: ReservationsRepo = {
  async create(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into reservations (user_id, operation_id, amount, request_id)
       values ($1, $2, $3, $4) returning *`,
      [input.userId, input.operationId ?? null, input.amount, input.requestId],
    );
    return mapReservation(rows[0]);
  },
  async getById(exec, id) {
    const { rows } = await exec.query<R>(`select * from reservations where id = $1`, [id]);
    return rows.length ? mapReservation(rows[0]) : null;
  },
  async getByUserRequest(exec, userId, requestId) {
    const { rows } = await exec.query<R>(
      `select * from reservations where user_id = $1 and request_id = $2`,
      [userId, requestId],
    );
    return rows.length ? mapReservation(rows[0]) : null;
  },
  async listStaleReserved(exec, cutoffIso, limit = 100) {
    const { rows } = await exec.query<R>(
      `select * from reservations where status = 'reserved' and created_at < $1 order by created_at limit $2`,
      [cutoffIso, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map(mapReservation);
  },
  async transition(exec, id, from, to) {
    const { rows } = await exec.query<R>(
      `update reservations set status = $2, updated_at = now()
       where id = $1 and status = any($3) returning *`,
      [id, to, from],
    );
    return rows.length ? mapReservation(rows[0]) : null;
  },
};

const usage: UsageRepo = {
  async record(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into usage_events (user_id, app_id, operation, request_id, status, latency_ms)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [
        input.userId,
        input.appId ?? null,
        input.operation,
        input.requestId,
        input.status,
        input.latencyMs ?? null,
      ],
    );
    return mapUsage(rows[0]);
  },
  async listByUser(exec, userId, limit = 50) {
    const { rows } = await exec.query<R>(
      `select * from usage_events where user_id = $1 order by created_at desc limit $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(mapUsage);
  },
};

const entitlements: EntitlementsRepo = {
  async grant(exec, userId, key) {
    const { rows } = await exec.query<R>(
      `insert into entitlements (user_id, key) values ($1, $2)
       on conflict (user_id, key) do update set user_id = excluded.user_id returning *`,
      [userId, key],
    );
    return mapEntitlement(rows[0]);
  },
  async listByUser(exec, userId) {
    const { rows } = await exec.query<R>(
      `select * from entitlements where user_id = $1 order by key`,
      [userId],
    );
    return rows.map(mapEntitlement);
  },
  async has(exec, userId, key) {
    const { rowCount } = await exec.query(
      `select 1 from entitlements where user_id = $1 and key = $2`,
      [userId, key],
    );
    return rowCount > 0;
  },
};

const acquisitions: AcquisitionsRepo = {
  async recordFirstSeen(exec, input) {
    const { rows } = await exec.query<R>(
      `insert into user_acquisitions (user_id, provider, start_param)
       values ($1, $2, $3)
       on conflict (user_id, provider) do nothing
       returning *`,
      [input.userId, input.provider, input.startParam],
    );
    if (rows.length) return mapAcquisition(rows[0]);
    const existing = await exec.query<R>(
      `select * from user_acquisitions where user_id = $1 and provider = $2`,
      [input.userId, input.provider],
    );
    return mapAcquisition(existing.rows[0]);
  },
  async getByUserProvider(exec, userId, provider) {
    const { rows } = await exec.query<R>(
      `select * from user_acquisitions where user_id = $1 and provider = $2`,
      [userId, provider],
    );
    return rows.length ? mapAcquisition(rows[0]) : null;
  },
};

/**
 * Bundle every repository. Methods take the executor explicitly, so the same
 * bundle works on a plain connection and inside `withTransaction`:
 * `await db.withTransaction((tx) => repos.wallets.adjust(tx, ...))`.
 */
export function createRepos(): Repos {
  return {
    users,
    identities,
    profiles,
    sessions,
    registry,
    wallets,
    ledger,
    reservations,
    usage,
    entitlements,
    acquisitions,
  };
}

export type { DbExecutor };
