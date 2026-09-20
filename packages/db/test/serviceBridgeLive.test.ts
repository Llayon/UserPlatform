/**
 * Live service-bridge constraint verification (gated on DATABASE_URL).
 * Proves the migration is actually applied remotely, not just in memory:
 * - service_credentials table exists with unique key_id + FK + status CHECK
 * - sessions carries session_type/app_id with the CHECK invariant
 * - existing account sessions remain valid (account + NULL app)
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { DbCheckError, DbConflictError, type Db } from "../src/executor.js";
import { createPgDb, createRepos } from "../src/index.js";
import { hashServiceSecret } from "@user-platform/auth-core";

const DATABASE_URL = process.env.DATABASE_URL;
const DB_TIMEOUT = 30000;
function itDb(name: string, fn: () => Promise<void>): void {
  if (DATABASE_URL) it(name, fn, DB_TIMEOUT);
  else it.skip(name, fn);
}

let db: Db | null = null;
function getDb(): Db {
  if (!db) db = createPgDb(DATABASE_URL as string, { maxConnections: 4 });
  return db;
}

const repos = createRepos();
const createdUserIds: string[] = [];
const createdKeyIds: string[] = [];

afterAll(async () => {
  if (db) await db.close();
});

afterEach(async () => {
  if (!DATABASE_URL) return;
  for (const id of createdUserIds.splice(0)) {
    try {
      await repos.users.deleteById(getDb(), id);
    } catch {
      // best-effort
    }
  }
  for (const keyId of createdKeyIds.splice(0)) {
    try {
      await getDb().query(`delete from service_credentials where key_id = $1`, [keyId]);
    } catch {
      // best-effort
    }
  }
});

describe("service bridge live constraints (gated)", () => {
  itDb("service_credentials round-trip with unique key_id", async () => {
    const db = getDb();
    const fridge = await repos.registry.getAppBySlug(db, "fridge");
    expect(fridge).not.toBeNull();
    const keyId = `live${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    createdKeyIds.push(keyId);
    const row = await repos.serviceCredentials.create(db, {
      appId: fridge!.id,
      keyId,
      secretHash: hashServiceSecret("live-secret"),
      label: "live-test",
    });
    expect(row.status).toBe("active");
    expect((await repos.serviceCredentials.findByKeyId(db, keyId))?.id).toBe(row.id);
    await expect(
      repos.serviceCredentials.create(db, {
        appId: fridge!.id,
        keyId,
        secretHash: "other",
      }),
    ).rejects.toBeInstanceOf(DbConflictError);
    expect(await repos.serviceCredentials.revokeByKeyId(db, keyId)).not.toBeNull();
    expect(await repos.serviceCredentials.revokeByKeyId(db, keyId)).toBeNull();
  });

  itDb("sessions enforce account/app CHECK live", async () => {
    const db = getDb();
    const user = await repos.users.create(db, {});
    createdUserIds.push(user.id);
    const fridge = await repos.registry.getAppBySlug(db, "fridge");
    // account + NULL app: valid (legacy rows look like this)
    const acct = await repos.sessions.create(db, {
      tokenHash: `live-${randomUUID()}`,
      userId: user.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(acct.sessionType).toBe("account");
    // account + app: rejected by CHECK
    await expect(
      repos.sessions.create(db, {
        tokenHash: `live-${randomUUID()}`,
        userId: user.id,
        expiresAt: "2999-01-01T00:00:00.000Z",
        sessionType: "account",
        appId: fridge!.id,
      }),
    ).rejects.toBeInstanceOf(DbCheckError);
    // app + NULL: rejected
    await expect(
      repos.sessions.create(db, {
        tokenHash: `live-${randomUUID()}`,
        userId: user.id,
        expiresAt: "2999-01-01T00:00:00.000Z",
        sessionType: "app",
        appId: null,
      }),
    ).rejects.toBeInstanceOf(DbCheckError);
    // app + app: valid
    const appSession = await repos.sessions.create(db, {
      tokenHash: `live-${randomUUID()}`,
      userId: user.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
      sessionType: "app",
      appId: fridge!.id,
    });
    expect(appSession.appId).toBe(fridge!.id);
  });
});
