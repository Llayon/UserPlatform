/**
 * In-memory repository fakes for unit tests (no Postgres needed).
 * Enforces the SAME constraint semantics as the real schema:
 * unique identities, unique reservation request IDs, unique ledger
 * idempotency keys, non-negative wallet balances, legal status transitions.
 * Anything weaker here would make unit tests lie — critic guards this.
 */
import { randomUUID } from "node:crypto";
import { DbCheckError, DbConflictError, DbForeignKeyError } from "./executor.js";
import type {
  EntitlementsRepo,
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
import type {
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
  ReservationStatus,
} from "./types.js";

export interface MemoryStore {
  users: Map<string, DbUser>;
  identities: Map<string, DbIdentity>;
  profiles: Map<string, DbProfile>;
  sessions: Map<string, DbSession>;
  wallets: Map<string, DbWallet>;
  ledger: Map<string, DbLedgerEntry>;
  reservations: Map<string, DbReservation>;
  usage: Map<string, DbUsageEvent>;
  entitlements: Map<string, DbEntitlement>;
}

export function createMemoryStore(): MemoryStore {
  return {
    users: new Map(),
    identities: new Map(),
    profiles: new Map(),
    sessions: new Map(),
    wallets: new Map(),
    ledger: new Map(),
    reservations: new Map(),
    usage: new Map(),
    entitlements: new Map(),
  };
}

const now = () => new Date().toISOString();

function requireUser(store: MemoryStore, userId: string): void {
  if (!store.users.has(userId)) throw new DbForeignKeyError(`unknown user ${userId}`);
}

const SEED_APPS: DbApp[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "fridge",
    displayName: "Что приготовить",
    status: "active",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    slug: "wardrobe",
    displayName: "Мой гардероб",
    status: "coming_soon",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    slug: "interior",
    displayName: "Интерьер",
    status: "coming_soon",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
];

const SEED_OPERATIONS: DbOperation[] = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    appId: SEED_APPS[0].id,
    operationKey: "fridge.scan",
    creditCost: 1,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    appId: SEED_APPS[0].id,
    operationKey: "fridge.recipe",
    creditCost: 0,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    appId: SEED_APPS[1].id,
    operationKey: "wardrobe.scan",
    creditCost: 1,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000004",
    appId: SEED_APPS[1].id,
    operationKey: "wardrobe.outfit",
    creditCost: 1,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    appId: SEED_APPS[1].id,
    operationKey: "wardrobe.shopping_check",
    creditCost: 1,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  {
    id: "10000000-0000-0000-0000-000000000006",
    appId: SEED_APPS[2].id,
    operationKey: "interior.analyze",
    creditCost: 2,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
];

export function createMemoryRepos(store: MemoryStore = createMemoryStore()): Repos {
  const users: UsersRepo = {
    async create(_exec, input) {
      const status = input?.status ?? "active";
      if (status !== "active" && status !== "suspended") {
        throw new DbCheckError(`invalid status ${status}`);
      }
      const user: DbUser = { id: randomUUID(), status, createdAt: now(), updatedAt: now() };
      store.users.set(user.id, user);
      return { ...user };
    },
    async getById(_exec, id) {
      const u = store.users.get(id);
      return u ? { ...u } : null;
    },
    async deleteById(_exec, id) {
      store.users.delete(id);
      for (const [k, v] of store.identities) if (v.userId === id) store.identities.delete(k);
      store.profiles.delete(id);
      for (const [k, v] of store.sessions) if (v.userId === id) store.sessions.delete(k);
      store.wallets.delete(id);
      for (const [k, v] of store.ledger) if (v.userId === id) store.ledger.delete(k);
      for (const [k, v] of store.reservations) if (v.userId === id) store.reservations.delete(k);
      for (const [k, v] of store.usage) if (v.userId === id) store.usage.delete(k);
      for (const [k, v] of store.entitlements) if (v.userId === id) store.entitlements.delete(k);
    },
  };

  const identities: IdentitiesRepo = {
    async create(_exec, input) {
      requireUser(store, input.userId);
      for (const existing of store.identities.values()) {
        if (
          existing.provider === input.provider &&
          existing.providerUserId === input.providerUserId
        ) {
          throw new DbConflictError("identity already linked");
        }
      }
      const identity: DbIdentity = {
        id: randomUUID(),
        userId: input.userId,
        provider: input.provider,
        providerUserId: input.providerUserId,
        providerUsername: input.providerUsername ?? null,
        createdAt: now(),
        lastSeenAt: now(),
      };
      store.identities.set(identity.id, identity);
      return { ...identity };
    },
    async findByProvider(_exec, provider, providerUserId) {
      for (const identity of store.identities.values()) {
        if (identity.provider === provider && identity.providerUserId === providerUserId) {
          return { ...identity };
        }
      }
      return null;
    },
    async touchLastSeen(_exec, id, atIso) {
      const identity = store.identities.get(id);
      if (identity) identity.lastSeenAt = atIso ?? now();
    },
  };

  const profiles: ProfilesRepo = {
    async create(_exec, input) {
      requireUser(store, input.userId);
      if (store.profiles.has(input.userId)) throw new DbConflictError("profile exists");
      const profile: DbProfile = {
        userId: input.userId,
        displayName: input.displayName ?? "",
        avatarUrl: input.avatarUrl ?? null,
        locale: input.locale ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.profiles.set(profile.userId, profile);
      return { ...profile };
    },
    async getByUserId(_exec, userId) {
      const p = store.profiles.get(userId);
      return p ? { ...p } : null;
    },
  };

  const sessions: SessionsRepo = {
    async create(_exec, input) {
      requireUser(store, input.userId);
      if (store.sessions.has(input.tokenHash)) throw new DbConflictError("session exists");
      const session: DbSession = {
        tokenHash: input.tokenHash,
        userId: input.userId,
        createdAt: now(),
        expiresAt: input.expiresAt,
      };
      store.sessions.set(session.tokenHash, session);
      return { ...session };
    },
    async getByTokenHash(_exec, tokenHash) {
      const s = store.sessions.get(tokenHash);
      return s ? { ...s } : null;
    },
    async deleteByTokenHash(_exec, tokenHash) {
      store.sessions.delete(tokenHash);
    },
    async deleteExpired(_exec, nowIso) {
      const nowIsoValue = nowIso ?? now();
      let count = 0;
      for (const [k, v] of store.sessions) {
        if (v.expiresAt < nowIsoValue) {
          store.sessions.delete(k);
          count += 1;
        }
      }
      return count;
    },
  };

  const registry: RegistryRepo = {
    async listApps() {
      return SEED_APPS.map((a) => ({ ...a }));
    },
    async listOperations() {
      return SEED_OPERATIONS.map((o) => ({ ...o }));
    },
    async findOperationByKey(_exec, fullKey) {
      const op = SEED_OPERATIONS.find((o) => o.operationKey === fullKey);
      return op ? { ...op } : null;
    },
  };

  const wallets: WalletsRepo = {
    async create(_exec, userId) {
      requireUser(store, userId);
      if (store.wallets.has(userId)) throw new DbConflictError("wallet exists");
      const wallet: DbWallet = {
        userId,
        availableBalance: 0,
        reservedBalance: 0,
        version: 0,
        updatedAt: now(),
      };
      store.wallets.set(userId, wallet);
      return { ...wallet };
    },
    async getByUserId(_exec, userId) {
      const w = store.wallets.get(userId);
      return w ? { ...w } : null;
    },
    async adjust(_exec, userId, delta) {
      const wallet = store.wallets.get(userId);
      if (!wallet) return null;
      if (delta.expectedVersion !== undefined && wallet.version !== delta.expectedVersion) {
        return null;
      }
      const available = wallet.availableBalance + (delta.available ?? 0);
      const reserved = wallet.reservedBalance + (delta.reserved ?? 0);
      if (available < 0 || reserved < 0) throw new DbCheckError("balance would go negative");
      wallet.availableBalance = available;
      wallet.reservedBalance = reserved;
      wallet.version += 1;
      wallet.updatedAt = now();
      return { ...wallet };
    },
  };

  const ledger: LedgerRepo = {
    async append(_exec, input) {
      requireUser(store, input.userId);
      for (const entry of store.ledger.values()) {
        if (entry.userId === input.userId && entry.idempotencyKey === input.idempotencyKey) {
          throw new DbConflictError("duplicate idempotency key");
        }
      }
      const entry: DbLedgerEntry = {
        id: randomUUID(),
        userId: input.userId,
        delta: input.delta,
        balanceAfter: input.balanceAfter,
        appId: input.appId ?? null,
        operationId: input.operationId ?? null,
        reservationId: input.reservationId ?? null,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? {},
        createdAt: now(),
      };
      store.ledger.set(entry.id, entry);
      return { ...entry };
    },
    async listByUser(_exec, userId, limit = 50) {
      return [...store.ledger.values()]
        .filter((e) => e.userId === userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, Math.min(Math.max(limit, 1), 200))
        .map((e) => ({ ...e }));
    },
  };

  const reservations: ReservationsRepo = {
    async create(_exec, input) {
      requireUser(store, input.userId);
      if (input.amount < 0) throw new DbCheckError("negative amount");
      for (const r of store.reservations.values()) {
        if (r.userId === input.userId && r.requestId === input.requestId) {
          throw new DbConflictError("duplicate request id");
        }
      }
      const reservation: DbReservation = {
        id: randomUUID(),
        userId: input.userId,
        operationId: input.operationId ?? null,
        amount: input.amount,
        status: "reserved",
        requestId: input.requestId,
        createdAt: now(),
        updatedAt: now(),
      };
      store.reservations.set(reservation.id, reservation);
      return { ...reservation };
    },
    async getById(_exec, id) {
      const r = store.reservations.get(id);
      return r ? { ...r } : null;
    },
    async getByUserRequest(_exec, userId, requestId) {
      for (const r of store.reservations.values()) {
        if (r.userId === userId && r.requestId === requestId) return { ...r };
      }
      return null;
    },
    async transition(_exec, id, from: ReservationStatus[], to: ReservationStatus) {
      const r = store.reservations.get(id);
      if (!r || !from.includes(r.status)) return null;
      r.status = to;
      r.updatedAt = now();
      return { ...r };
    },
  };

  const usage: UsageRepo = {
    async record(_exec, input) {
      requireUser(store, input.userId);
      const event: DbUsageEvent = {
        id: randomUUID(),
        userId: input.userId,
        appId: input.appId ?? null,
        operation: input.operation,
        requestId: input.requestId,
        status: input.status,
        latencyMs: input.latencyMs ?? null,
        createdAt: now(),
      };
      store.usage.set(event.id, event);
      return { ...event };
    },
    async listByUser(_exec, userId, limit = 50) {
      return [...store.usage.values()]
        .filter((e) => e.userId === userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, Math.min(Math.max(limit, 1), 200))
        .map((e) => ({ ...e }));
    },
  };

  const entitlements: EntitlementsRepo = {
    async grant(_exec, userId, key) {
      requireUser(store, userId);
      const composite = `${userId}:${key}`;
      const existing = store.entitlements.get(composite);
      if (existing) return { ...existing };
      const entitlement: DbEntitlement = { userId, key, createdAt: now() };
      store.entitlements.set(composite, entitlement);
      return { ...entitlement };
    },
    async listByUser(_exec, userId) {
      return [...store.entitlements.values()]
        .filter((e) => e.userId === userId)
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map((e) => ({ ...e }));
    },
    async has(_exec, userId, key) {
      return store.entitlements.has(`${userId}:${key}`);
    },
  };

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
  };
}
