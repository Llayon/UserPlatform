/**
 * Repository interfaces — one per aggregate, thin CRUD over migrated tables.
 * All methods take effect on the passed executor (plain connection or tx).
 * Cross-table atomic flows (signup, reserve→commit) compose these inside
 * `Db.withTransaction` in Phase 2/3 service code, never inside repos.
 */
import type { DbExecutor } from "./executor.js";
import type {
  AppStatus,
  DbApp,
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
} from "./types.js";

export interface UsersRepo {
  create(exec: DbExecutor, input?: { status?: UserStatus }): Promise<DbUser>;
  getById(exec: DbExecutor, id: string): Promise<DbUser | null>;
  deleteById(exec: DbExecutor, id: string): Promise<void>;
}

export interface IdentitiesRepo {
  create(
    exec: DbExecutor,
    input: {
      userId: string;
      provider: IdentityProvider;
      providerUserId: string;
      providerUsername?: string | null;
    },
  ): Promise<DbIdentity>;
  findByProvider(
    exec: DbExecutor,
    provider: IdentityProvider,
    providerUserId: string,
  ): Promise<DbIdentity | null>;
  touchLastSeen(exec: DbExecutor, id: string, atIso?: string): Promise<void>;
}

export interface ProfilesRepo {
  create(
    exec: DbExecutor,
    input: {
      userId: string;
      displayName?: string;
      avatarUrl?: string | null;
      locale?: string | null;
    },
  ): Promise<DbProfile>;
  getByUserId(exec: DbExecutor, userId: string): Promise<DbProfile | null>;
}

export interface SessionsRepo {
  create(
    exec: DbExecutor,
    input: { tokenHash: string; userId: string; expiresAt: string },
  ): Promise<DbSession>;
  getByTokenHash(exec: DbExecutor, tokenHash: string): Promise<DbSession | null>;
  deleteByTokenHash(exec: DbExecutor, tokenHash: string): Promise<void>;
  deleteExpired(exec: DbExecutor, nowIso?: string): Promise<number>;
}

export interface RegistryRepo {
  listApps(exec: DbExecutor): Promise<DbApp[]>;
  listOperations(exec: DbExecutor): Promise<DbOperation[]>;
  /** Full key form "app.operation" (e.g. "fridge.scan"). Returns null when missing/disabled-aware by caller. */
  findOperationByKey(exec: DbExecutor, fullKey: string): Promise<DbOperation | null>;
}

export interface WalletsRepo {
  create(exec: DbExecutor, userId: string): Promise<DbWallet>;
  getByUserId(exec: DbExecutor, userId: string): Promise<DbWallet | null>;
  /**
   * Adjust balances atomically. Deltas may be negative but the CHECK
   * constraints reject results below zero (surfaces as DbCheckError).
   * When expectedVersion is set, the row is updated only on version match
   * (optimistic locking); returns null on version mismatch.
   */
  adjust(
    exec: DbExecutor,
    userId: string,
    delta: { available?: number; reserved?: number; expectedVersion?: number },
  ): Promise<DbWallet | null>;
}

export interface LedgerRepo {
  append(
    exec: DbExecutor,
    input: {
      userId: string;
      delta: number;
      balanceAfter: number;
      appId?: string | null;
      operationId?: string | null;
      reservationId?: string | null;
      reason: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<DbLedgerEntry>;
  listByUser(exec: DbExecutor, userId: string, limit?: number): Promise<DbLedgerEntry[]>;
}

export interface ReservationsRepo {
  create(
    exec: DbExecutor,
    input: { userId: string; operationId?: string | null; amount: number; requestId: string },
  ): Promise<DbReservation>;
  getById(exec: DbExecutor, id: string): Promise<DbReservation | null>;
  getByUserRequest(
    exec: DbExecutor,
    userId: string,
    requestId: string,
  ): Promise<DbReservation | null>;
  /**
   * Race-safe status transition: updates only when current status is in
   * `from`. Returns the updated row, or null when the transition is illegal
   * (already committed/released by a concurrent request).
   */
  transition(
    exec: DbExecutor,
    id: string,
    from: ReservationStatus[],
    to: ReservationStatus,
  ): Promise<DbReservation | null>;
}

export interface UsageRepo {
  record(
    exec: DbExecutor,
    input: {
      userId: string;
      appId?: string | null;
      operation: string;
      requestId: string;
      status: UsageStatus;
      latencyMs?: number | null;
    },
  ): Promise<DbUsageEvent>;
  listByUser(exec: DbExecutor, userId: string, limit?: number): Promise<DbUsageEvent[]>;
}

export interface EntitlementsRepo {
  grant(exec: DbExecutor, userId: string, key: string): Promise<DbEntitlement>;
  listByUser(exec: DbExecutor, userId: string): Promise<DbEntitlement[]>;
  has(exec: DbExecutor, userId: string, key: string): Promise<boolean>;
}

/** Bundle factory: binds all repos to one executor (connection or tx). */
export interface Repos {
  users: UsersRepo;
  identities: IdentitiesRepo;
  profiles: ProfilesRepo;
  sessions: SessionsRepo;
  registry: RegistryRepo;
  wallets: WalletsRepo;
  ledger: LedgerRepo;
  reservations: ReservationsRepo;
  usage: UsageRepo;
  entitlements: EntitlementsRepo;
}

export type { AppStatus, UserStatus };
