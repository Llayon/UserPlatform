/**
 * Credit engine: reserve → commit | release lifecycle over the ledger/wallet.
 *
 * Each mutating call runs in ONE database transaction. Idempotency rules:
 * - reserve with a seen (userId, requestId) returns the existing reservation
 *   (reused: true) — network retries never double-reserve;
 * - commit/release are legal-transition-only; repeating them returns the
 *   current state without touching balances or the ledger;
 * - commit appends exactly one ledger row under `commit:<reservationId>`.
 *
 * Money movement summary:
 * - reserve: available -= amount, reserved += amount (atomic conditional).
 * - commit: reserved -= amount; ledger delta = -amount.
 * - release: available += amount, reserved -= amount; no ledger row
 *   (net movement is zero; the full trail lives in usage_events).
 *
 * The engine takes an explicit userId. Binding that ID to a session or a
 * service credential is the HTTP layer's job (Phase 4) — never the client's.
 */
import {
  DbConflictError,
  type Db,
  type DbReservation,
  type DbTx,
  type DbWallet,
  type Repos,
} from "@user-platform/db";

export type CreditErrorCode =
  | "UNKNOWN_OPERATION"
  | "OPERATION_DISABLED"
  | "ACCOUNT_SUSPENDED"
  | "INSUFFICIENT_CREDITS"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_STATE";

export class CreditError extends Error {
  readonly code: CreditErrorCode;
  constructor(code: CreditErrorCode, message: string) {
    super(message);
    this.name = "CreditError";
    this.code = code;
  }
}

export interface CreditDeps {
  db: Db;
  repos: Repos;
}

export interface BalanceView {
  available: number;
  reserved: number;
}

export interface ReserveOutcome {
  reservation: DbReservation;
  balance: BalanceView;
  /** True when requestId was already seen (retry — no new charge). */
  reused: boolean;
}

export interface CommitOutcome {
  reservation: DbReservation;
  balance: BalanceView;
  /** True when the reservation was already committed (retry — no-op). */
  reused: boolean;
}

export interface ReleaseOutcome {
  reservation: DbReservation;
  balance: BalanceView;
  /** True when the reservation was already released (retry — no-op). */
  reused: boolean;
}

function balanceOf(wallet: DbWallet): BalanceView {
  return { available: wallet.availableBalance, reserved: wallet.reservedBalance };
}

async function loadOperation(
  repos: Repos,
  tx: DbTx,
  operation: string,
): Promise<{ id: string; appId: string; cost: number }> {
  const op = await repos.registry.findOperationByKey(tx, operation);
  if (!op) throw new CreditError("UNKNOWN_OPERATION", `Unknown operation ${operation}`);
  if (!op.enabled) throw new CreditError("OPERATION_DISABLED", `Operation disabled ${operation}`);
  return { id: op.id, appId: op.appId, cost: op.creditCost };
}

async function readBalance(repos: Repos, tx: DbTx, userId: string): Promise<BalanceView> {
  const wallet = await repos.wallets.getByUserId(tx, userId);
  return wallet ? balanceOf(wallet) : { available: 0, reserved: 0 };
}

/**
 * Spending guard: suspended accounts cannot reserve/commit/release, even via
 * service calls. Reads (getBalance) stay open. Failing inputs are rejected
 * fast so oversized strings never reach UNIQUE keys or logs. Unknown users
 * fail as INSUFFICIENT_CREDITS (fail-closed: nonexistent money can't move).
 */
async function requireActiveSpender(
  repos: Repos,
  tx: DbTx,
  userId: string,
  input: { operation?: string; requestId?: string },
): Promise<void> {
  if (!userId) throw new CreditError("INSUFFICIENT_CREDITS", "Unknown user");
  if (
    input.operation !== undefined &&
    (input.operation.length === 0 || input.operation.length > 128)
  ) {
    throw new CreditError("UNKNOWN_OPERATION", "Bad operation reference");
  }
  if (
    input.requestId !== undefined &&
    (input.requestId.length === 0 || input.requestId.length > 128)
  ) {
    throw new CreditError("RESERVATION_STATE", "Bad request reference");
  }
  const user = await repos.users.getById(tx, userId);
  if (!user) throw new CreditError("INSUFFICIENT_CREDITS", "Unknown user");
  if (user.status !== "active") throw new CreditError("ACCOUNT_SUSPENDED", "Account suspended");
}

/** Current balances (read-only; missing wallet reads as zero). */
export async function getBalance(deps: CreditDeps, userId: string): Promise<BalanceView> {
  const wallet = await deps.repos.wallets.getByUserId(deps.db, userId);
  return wallet ? balanceOf(wallet) : { available: 0, reserved: 0 };
}

/**
 * Reserve `cost(operation)` credits for requestId.
 * Rejects BEFORE any external AI work when funds are insufficient.
 * Safe under concurrency: a same-requestId collision after funds moved
 * aborts (rolling the deduction back) and retries once as a read — the
 * winner's reservation is returned, funds move exactly once.
 */
export async function reserve(
  deps: CreditDeps,
  input: { userId: string; operation: string; requestId: string },
): Promise<ReserveOutcome> {
  const { db, repos } = deps;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.withTransaction(async (tx) => {
        await requireActiveSpender(repos, tx, input.userId, {
          operation: input.operation,
          requestId: input.requestId,
        });
        const op = await loadOperation(repos, tx, input.operation);

        const seen = await repos.reservations.getByUserRequest(tx, input.userId, input.requestId);
        if (seen) {
          return {
            reservation: seen,
            balance: await readBalance(repos, tx, input.userId),
            reused: true,
          };
        }

        const wallet = await repos.wallets.tryReserve(tx, input.userId, op.cost);
        if (!wallet) {
          throw new CreditError(
            "INSUFFICIENT_CREDITS",
            `Insufficient credits for ${input.operation}`,
          );
        }
        try {
          const reservation = await repos.reservations.create(tx, {
            userId: input.userId,
            operationId: op.id,
            amount: op.cost,
            requestId: input.requestId,
          });
          await repos.usage.record(tx, {
            userId: input.userId,
            appId: op.appId,
            operation: input.operation,
            requestId: input.requestId,
            status: "reserved",
          });
          return { reservation, balance: balanceOf(wallet), reused: false };
        } catch (err) {
          if (err instanceof DbConflictError) {
            // Same-requestId winner committed first: aborting this tx rolls
            // our deduction back; the loop below re-reads the winner.
            throw new RetryAsRead();
          }
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof RetryAsRead && attempt === 0) continue;
      throw err;
    }
  }
  throw new CreditError("RESERVATION_STATE", "Concurrent duplicate reservation");
}

/** Internal control-flow marker (never escapes the engine). */
class RetryAsRead extends Error {
  constructor() {
    super("retry-as-read");
    this.name = "RetryAsRead";
  }
}

async function loadOperationById(
  repos: Repos,
  tx: DbTx,
  reservation: { operationId: string | null },
): Promise<{ id: string; appId: string; key: string } | null> {
  if (!reservation.operationId) return null;
  const op = await repos.registry.getOperationById(tx, reservation.operationId);
  return op ? { id: op.id, appId: op.appId, key: op.operationKey } : null;
}

/**
 * Commit a reservation after successful external work.
 * Idempotent: repeating a commit returns the committed state untouched.
 * Rejects reservations that are not reserved (released, unknown, or foreign).
 */
export async function commit(
  deps: CreditDeps,
  input: { userId: string; reservationId: string },
): Promise<CommitOutcome> {
  const { db, repos } = deps;
  return db
    .withTransaction(async (tx) => {
      const current = await repos.reservations.getById(tx, input.reservationId);
      if (!current || current.userId !== input.userId) {
        throw new CreditError("RESERVATION_NOT_FOUND", "Reservation not found");
      }
      await requireActiveSpender(repos, tx, input.userId, {});
      if (current.status === "committed") {
        return {
          reservation: current,
          balance: await readBalance(repos, tx, input.userId),
          reused: true,
        };
      }
      if (current.status !== "reserved") {
        throw new CreditError("RESERVATION_STATE", `Cannot commit ${current.status} reservation`);
      }
      const op = await loadOperationById(repos, tx, current);
      const moved = await repos.reservations.transition(tx, current.id, ["reserved"], "committed");
      if (!moved) {
        // Lost a commit race: re-read the winner's state (now committed).
        const winner = await repos.reservations.getById(tx, input.reservationId);
        if (winner && winner.status === "committed") {
          return {
            reservation: winner,
            balance: await readBalance(repos, tx, input.userId),
            reused: true,
          };
        }
        throw new CreditError("RESERVATION_STATE", "Concurrent commit conflict");
      }
      const wallet = await repos.wallets.adjust(tx, current.userId, { reserved: -current.amount });
      if (!wallet) throw new CreditError("RESERVATION_STATE", "Wallet missing mid-commit");
      // Ledger key is per-reservation: defense-in-depth against double-append.
      try {
        await repos.ledger.append(tx, {
          userId: current.userId,
          delta: -current.amount,
          balanceAfter: wallet.availableBalance,
          appId: op?.appId ?? null,
          operationId: op?.id ?? current.operationId,
          reservationId: current.id,
          reason: "commit",
          idempotencyKey: `commit:${current.id}`,
        });
      } catch (err) {
        if (!(err instanceof DbConflictError)) throw err;
        // A duplicate commit row means this reservation already settled:
        // balances were just moved by THIS tx, so abort and re-read.
        throw new RetryAsRead();
      }
      await repos.usage.record(tx, {
        userId: current.userId,
        appId: op?.appId ?? null,
        operation: op?.key ?? "unknown.operation",
        requestId: current.requestId,
        status: "committed",
      });
      return {
        reservation: moved,
        balance: balanceOf(wallet),
        reused: false,
      };
    })
    .catch(async (err) => {
      if (err instanceof RetryAsRead) {
        return deps.db.withTransaction(async (tx) => {
          const winner = await repos.reservations.getById(tx, input.reservationId);
          if (!winner) throw new CreditError("RESERVATION_NOT_FOUND", "Reservation not found");
          return {
            reservation: winner,
            balance: await readBalance(repos, tx, input.userId),
            reused: true,
          };
        });
      }
      throw err;
    });
}

/**
 * Release a reservation after external failure (or cancellation).
 * Returns funds available += amount, reserved -= amount. No ledger row:
 * net movement is zero and the trail lives in usage_events.
 * Idempotent: repeating a release returns the released state untouched.
 */
export async function release(
  deps: CreditDeps,
  input: { userId: string; reservationId: string },
): Promise<ReleaseOutcome> {
  const { db, repos } = deps;
  return db.withTransaction(async (tx) => {
    const current = await repos.reservations.getById(tx, input.reservationId);
    if (!current || current.userId !== input.userId) {
      throw new CreditError("RESERVATION_NOT_FOUND", "Reservation not found");
    }
    await requireActiveSpender(repos, tx, input.userId, {});
    if (current.status === "released") {
      return {
        reservation: current,
        balance: await readBalance(repos, tx, input.userId),
        reused: true,
      };
    }
    if (current.status !== "reserved") {
      throw new CreditError("RESERVATION_STATE", `Cannot release ${current.status} reservation`);
    }
    const op = await loadOperationById(repos, tx, current);
    const moved = await repos.reservations.transition(tx, current.id, ["reserved"], "released");
    if (!moved) {
      const winner = await repos.reservations.getById(tx, input.reservationId);
      if (winner && winner.status === "released") {
        return {
          reservation: winner,
          balance: await readBalance(repos, tx, input.userId),
          reused: true,
        };
      }
      throw new CreditError("RESERVATION_STATE", "Concurrent release conflict");
    }
    const wallet = await repos.wallets.adjust(tx, current.userId, {
      available: current.amount,
      reserved: -current.amount,
    });
    if (!wallet) throw new CreditError("RESERVATION_STATE", "Wallet missing mid-release");
    await repos.usage.record(tx, {
      userId: current.userId,
      appId: op?.appId ?? null,
      operation: op?.key ?? "unknown.operation",
      requestId: current.requestId,
      status: "released",
    });
    return { reservation: moved, balance: balanceOf(wallet), reused: false };
  });
}

/**
 * Crash recovery: release all reservations still `reserved` and older than
 * the given age. Returns the number of recovered reservations.
 * Intended for a periodic sweeper, not the request path.
 */
export async function releaseStale(
  deps: CreditDeps,
  olderThanMs: number,
  nowMs = Date.now(),
): Promise<number> {
  const { db, repos } = deps;
  const cutoff = new Date(nowMs - olderThanMs).toISOString();
  const stale = await db.withTransaction((tx) =>
    repos.reservations.listStaleReserved(tx, cutoff, 100),
  );
  let recovered = 0;
  for (const s of stale) {
    try {
      await release(deps, { userId: s.userId, reservationId: s.id });
      recovered += 1;
    } catch {
      // Already settled by a concurrent worker — skip.
    }
  }
  return recovered;
}
