/**
 * Gated live-DB race test: 10 parallel exchanges of the SAME identity must
 * yield exactly ONE user, ONE welcome bonus, and zero leaked rows.
 * Runs only with DATABASE_URL (local .env.local); otherwise skips.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createPgDb, createRepos, type Db } from "@user-platform/db";
import { exchangeIdentity } from "../src/services/exchange.js";

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

describe("exchange race (gated)", () => {
  itDb("10 parallel first-logins: one user, one bonus, one acquisition", async () => {
    const pid = `itest-tg-${randomUUID()}`;
    const identity = {
      provider: "telegram" as const,
      providerUserId: pid,
      username: "racer",
      firstName: "Гонка",
      languageCode: "ru",
    };
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        exchangeIdentity(
          { db: getDb(), repos, telegramBotToken: "t", maxBotToken: "m" },
          identity,
          { explicitStartParam: i === 0 ? "fridge_scan" : "campaign_9" },
        ),
      ),
    );
    const userIds = new Set(outcomes.map((o) => o.userId));
    expect(userIds.size).toBe(1);
    const userId = outcomes[0].userId;
    createdUserIds.push(userId);
    expect(outcomes.filter((o) => o.isNewUser)).toHaveLength(1);
    for (const o of outcomes) expect(o.availableBalance).toBe(10);

    const ledger = await repos.ledger.listByUser(getDb(), userId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 10, reason: "welcome_bonus" });

    const sessions = await getDb().query(
      "select count(*)::int as n from sessions where user_id = $1",
      [userId],
    );
    expect((sessions.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);

    const acq = await repos.acquisitions.getByUserProvider(getDb(), userId, "telegram");
    expect(acq).not.toBeNull();
    // First-seen wins; value is one of the two sanitized inputs (race order
    // decides which exchange committed first — both are valid telemetry).
    expect(["fridge_scan", "campaign_9"]).toContain(acq?.startParam);
  });
});
