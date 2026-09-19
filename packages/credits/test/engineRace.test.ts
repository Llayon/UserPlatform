/**
 * Concurrency gauntlet §43 on live Postgres — runs ONLY with DATABASE_URL.
 * - balance 1 + 10 parallel unique reserves → exactly ONE succeeds, never negative;
 * - same requestId ×10 → one reservation, funds move once;
 * - parallel duplicate commit/release → single settlement;
 * - insufficient + disabled paths persist nothing.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createPgDb, createRepos, type Db } from "@user-platform/db";
import { commit, getBalance, release, reserve } from "../src/engine.js";

const DATABASE_URL = process.env.DATABASE_URL;
const DB_TIMEOUT = 60000;
function itDb(name: string, fn: () => Promise<void>): void {
  if (DATABASE_URL) it(name, fn, DB_TIMEOUT);
  else it.skip(name, fn);
}

let db: Db | null = null;
function getDb(): Db {
  if (!db) db = createPgDb(DATABASE_URL as string, { maxConnections: 8 });
  return db;
}
const repos = createRepos();
const createdUserIds: string[] = [];

async function fundedUser(amount: number): Promise<string> {
  const u = await repos.users.create(getDb(), {});
  await repos.wallets.create(getDb(), u.id);
  await repos.wallets.adjust(getDb(), u.id, { available: amount });
  createdUserIds.push(u.id);
  return u.id;
}

async function ledgerCount(userId: string): Promise<number> {
  return (await repos.ledger.listByUser(getDb(), userId)).length;
}

afterEach(async () => {
  if (!DATABASE_URL) return;
  for (const id of createdUserIds.splice(0)) {
    try {
      await repos.users.deleteById(getDb(), id);
    } catch {
      // best-effort
    }
  }
});

afterAll(async () => {
  if (db) await db.close();
});

describe("credit concurrency gauntlet §43 (gated)", () => {
  itDb(
    "balance 1 + 10 parallel unique reserves → exactly one succeeds, never negative",
    async () => {
      const userId = await fundedUser(1);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          reserve(
            { db: getDb(), repos },
            { userId, operation: "fridge.scan", requestId: `race-${randomUUID()}-${i}` },
          ),
        ),
      );
      const won = results.filter((r) => r.status === "fulfilled");
      const poor = results.filter(
        (r) =>
          r.status === "rejected" &&
          (r.reason as Error & { code?: string }).code === "INSUFFICIENT_CREDITS",
      );
      expect(won).toHaveLength(1);
      expect(poor).toHaveLength(9);
      expect(await getBalance({ db: getDb(), repos }, userId)).toEqual({
        available: 0,
        reserved: 1,
      });
    },
  );

  itDb("same requestId ×10 → one reservation, funds move once", async () => {
    const userId = await fundedUser(10);
    const requestId = `retry-${randomUUID()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        reserve({ db: getDb(), repos }, { userId, operation: "fridge.scan", requestId }),
      ),
    );
    expect(new Set(outcomes.map((o) => o.reservation.id)).size).toBe(1);
    expect(outcomes.filter((o) => !o.reused)).toHaveLength(1);
    expect(await getBalance({ db: getDb(), repos }, userId)).toEqual({ available: 9, reserved: 1 });
  });

  itDb("parallel duplicate commit settles once; duplicate release restores once", async () => {
    const userId = await fundedUser(10);
    const r = await reserve(
      { db: getDb(), repos },
      { userId, operation: "fridge.scan", requestId: `c-${randomUUID()}` },
    );
    const commits = await Promise.all([
      commit({ db: getDb(), repos }, { userId, reservationId: r.reservation.id }),
      commit({ db: getDb(), repos }, { userId, reservationId: r.reservation.id }),
    ]);
    expect(commits.filter((c) => !c.reused)).toHaveLength(1);
    expect(await ledgerCount(userId)).toBe(1);
    expect(await getBalance({ db: getDb(), repos }, userId)).toEqual({ available: 9, reserved: 0 });

    const r2 = await reserve(
      { db: getDb(), repos },
      { userId, operation: "fridge.scan", requestId: `r-${randomUUID()}` },
    );
    const releases = await Promise.all([
      release({ db: getDb(), repos }, { userId, reservationId: r2.reservation.id }),
      release({ db: getDb(), repos }, { userId, reservationId: r2.reservation.id }),
    ]);
    expect(releases.filter((c) => !c.reused)).toHaveLength(1);
    expect(await getBalance({ db: getDb(), repos }, userId)).toEqual({ available: 9, reserved: 0 });
    expect(await ledgerCount(userId)).toBe(1);
  });

  itDb("insufficient and disabled operations persist nothing", async () => {
    const userId = await fundedUser(0);
    const req = `poor-${randomUUID()}`;
    await expect(
      reserve({ db: getDb(), repos }, { userId, operation: "fridge.scan", requestId: req }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await repos.reservations.getByUserRequest(getDb(), userId, req)).toBeNull();
    await getDb().query(
      `update operations set enabled = false where operation_key = 'fridge.scan'`,
    );
    try {
      await expect(
        reserve(
          { db: getDb(), repos },
          { userId, operation: "fridge.scan", requestId: `d-${randomUUID()}` },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_DISABLED" });
    } finally {
      await getDb().query(
        `update operations set enabled = true where operation_key = 'fridge.scan'`,
      );
    }
  });
});
