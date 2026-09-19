/**
 * Postgres integration tests — run ONLY when DATABASE_URL is set
 * (local .env.local, never committed, never pasted in chat).
 * Otherwise every test skips and the suite stays green.
 *
 * Safety: tests create users with random `itest-` provider IDs and delete
 * them afterwards (cascades clean wallets/ledger/reservations). Seed rows
 * (apps/operations) are read-only. No other database is touched.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { DbCheckError, DbConflictError, type Db } from "../src/executor.js";
import { createPgDb, createRepos } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const itDb = DATABASE_URL ? it : it.skip;

let db: Db | null = null;
function getDb(): Db {
  if (!db) db = createPgDb(DATABASE_URL as string, { maxConnections: 4 });
  return db;
}

const repos = createRepos();
const createdUserIds: string[] = [];
const testIdentity = () => `itest-${randomUUID()}`;

async function createTestUser(): Promise<string> {
  const user = await repos.users.create(getDb(), {});
  createdUserIds.push(user.id);
  return user.id;
}

afterAll(async () => {
  if (db) await db.close();
});

afterEach(async () => {
  if (!DATABASE_URL) return;
  const ids = createdUserIds.splice(0);
  for (const id of ids) {
    try {
      await repos.users.deleteById(getDb(), id);
    } catch {
      // Best-effort cleanup; cascade absence is asserted per-test.
    }
  }
});

describe("postgres integration (gated)", () => {
  itDb("seed registry is present with expected costs", async () => {
    const apps = await repos.registry.listApps(getDb());
    expect(apps.map((a) => a.slug).sort()).toEqual(["fridge", "interior", "wardrobe"]);
    const ops = await repos.registry.listOperations(getDb());
    const costs = new Map(ops.map((o) => [o.operationKey, o.creditCost]));
    expect(costs.get("fridge.scan")).toBe(1);
    expect(costs.get("fridge.recipe")).toBe(0);
    expect(costs.get("wardrobe.outfit")).toBe(1);
    expect(costs.get("interior.analyze")).toBe(2);
    expect(await repos.registry.findOperationByKey(getDb(), "fridge.scan")).not.toBeNull();
    expect(await repos.registry.findOperationByKey(getDb(), "nope.nope")).toBeNull();
  });

  itDb("user lifecycle cascades on delete", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await repos.identities.create(db, {
      userId,
      provider: "telegram",
      providerUserId: testIdentity(),
    });
    await repos.profiles.create(db, { userId, displayName: "Тест" });
    await repos.wallets.create(db, userId);
    await repos.users.deleteById(db, userId);
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);
    expect(await repos.users.getById(db, userId)).toBeNull();
    expect(await repos.profiles.getByUserId(db, userId)).toBeNull();
    expect(await repos.wallets.getByUserId(db, userId)).toBeNull();
  });

  itDb("duplicate identity is rejected by UNIQUE(provider, provider_user_id)", async () => {
    const db = getDb();
    const a = await createTestUser();
    const b = await createTestUser();
    const pid = testIdentity();
    await repos.identities.create(db, { userId: a, provider: "max", providerUserId: pid });
    await expect(
      repos.identities.create(db, { userId: b, provider: "max", providerUserId: pid }),
    ).rejects.toBeInstanceOf(DbConflictError);
  });

  itDb("wallet CHECK rejects negative balances", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await repos.wallets.create(db, userId);
    await expect(repos.wallets.adjust(db, userId, { available: -1 })).rejects.toBeInstanceOf(
      DbCheckError,
    );
    expect(await repos.wallets.getByUserId(db, userId)).toMatchObject({ availableBalance: 0 });
  });

  itDb("10 parallel same-identity inserts: exactly one wins", async () => {
    const db = getDb();
    const pid = testIdentity();
    const userIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = await repos.users.create(db, {});
      userIds.push(u.id);
      createdUserIds.push(u.id);
    }
    const results = await Promise.allSettled(
      userIds.map((userId) =>
        repos.identities.create(db, { userId, provider: "telegram", providerUserId: pid }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof DbConflictError,
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
  });

  itDb("reservation + ledger idempotency keys survive retries", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const req = `itest-req-${randomUUID()}`;
    const first = await repos.reservations.create(db, { userId, amount: 1, requestId: req });
    await expect(
      repos.reservations.create(db, { userId, amount: 1, requestId: req }),
    ).rejects.toBeInstanceOf(DbConflictError);
    expect(await repos.reservations.getByUserRequest(db, userId, req)).toMatchObject({
      id: first.id,
    });
    await repos.ledger.append(db, {
      userId,
      delta: 10,
      balanceAfter: 10,
      reason: "welcome_bonus",
      idempotencyKey: "itest-welcome",
    });
    await expect(
      repos.ledger.append(db, {
        userId,
        delta: 10,
        balanceAfter: 20,
        reason: "welcome_bonus",
        idempotencyKey: "itest-welcome",
      }),
    ).rejects.toBeInstanceOf(DbConflictError);
  });

  itDb("transaction rollback discards partial writes", async () => {
    const db = getDb();
    let leaked = "";
    await expect(
      db.withTransaction(async (tx) => {
        const u = await repos.users.create(tx, {});
        leaked = u.id;
        await repos.wallets.create(tx, u.id);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repos.users.getById(db, leaked)).toBeNull();
    expect(await repos.wallets.getByUserId(db, leaked)).toBeNull();
  });

  itDb("concurrent commit transitions: exactly one wins", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const r = await repos.reservations.create(db, {
      userId,
      amount: 1,
      requestId: `itest-req-${randomUUID()}`,
    });
    const results = await Promise.all([
      repos.reservations.transition(db, r.id, ["reserved"], "committed"),
      repos.reservations.transition(db, r.id, ["reserved"], "committed"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repos.reservations.getById(db, r.id)).toMatchObject({ status: "committed" });
  });

  itDb("usage + entitlements round-trip", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await repos.usage.record(db, {
      userId,
      operation: "fridge.scan",
      requestId: `itest-u-${randomUUID()}`,
      status: "committed",
      latencyMs: 120,
    });
    expect(await repos.usage.listByUser(db, userId)).toHaveLength(1);
    await repos.entitlements.grant(db, userId, "premium");
    await repos.entitlements.grant(db, userId, "premium");
    expect(await repos.entitlements.has(db, userId, "premium")).toBe(true);
  });
});
