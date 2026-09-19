import { describe, it, expect, beforeEach } from "vitest";
import { DbCheckError, DbConflictError, DbForeignKeyError } from "../src/executor.js";
import { createMemoryRepos, createMemoryStore } from "../src/memory.js";

describe("memory repos: constraint parity with Postgres schema", () => {
  const noop = async () => ({ rows: [], rowCount: 0 });

  let repos: ReturnType<typeof createMemoryRepos>;
  beforeEach(() => {
    repos = createMemoryRepos(createMemoryStore());
  });

  it("same numeric ID on different providers are independent identities", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    const b = await repos.users.create(exec);
    await repos.identities.create(exec, {
      userId: a.id,
      provider: "telegram",
      providerUserId: "777",
    });
    const other = await repos.identities.create(exec, {
      userId: b.id,
      provider: "max",
      providerUserId: "777",
    });
    expect(other.provider).toBe("max");
    expect(await repos.identities.findByProvider(exec, "telegram", "777")).toMatchObject({
      userId: a.id,
    });
  });

  it("duplicate identity on same provider is rejected", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    const b = await repos.users.create(exec);
    await repos.identities.create(exec, {
      userId: a.id,
      provider: "telegram",
      providerUserId: "1",
    });
    await expect(
      repos.identities.create(exec, { userId: b.id, provider: "telegram", providerUserId: "1" }),
    ).rejects.toBeInstanceOf(DbConflictError);
  });

  it("identity for unknown user violates foreign key", async () => {
    const exec = { query: noop };
    await expect(
      repos.identities.create(exec, {
        userId: "00000000-0000-0000-0000-000000000000",
        provider: "web",
        providerUserId: "x",
      }),
    ).rejects.toBeInstanceOf(DbForeignKeyError);
  });

  it("reservation request IDs are idempotent per user, independent across users", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    const b = await repos.users.create(exec);
    const first = await repos.reservations.create(exec, {
      userId: a.id,
      amount: 1,
      requestId: "req-abc-123",
    });
    await expect(
      repos.reservations.create(exec, { userId: a.id, amount: 1, requestId: "req-abc-123" }),
    ).rejects.toBeInstanceOf(DbConflictError);
    const same = await repos.reservations.getByUserRequest(exec, a.id, "req-abc-123");
    expect(same?.id).toBe(first.id);
    const other = await repos.reservations.create(exec, {
      userId: b.id,
      amount: 1,
      requestId: "req-abc-123",
    });
    expect(other.id).not.toBe(first.id);
  });

  it("ledger idempotency keys are unique per user", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    await repos.ledger.append(exec, {
      userId: a.id,
      delta: 10,
      balanceAfter: 10,
      reason: "welcome_bonus",
      idempotencyKey: "welcome",
    });
    await expect(
      repos.ledger.append(exec, {
        userId: a.id,
        delta: 10,
        balanceAfter: 20,
        reason: "welcome_bonus",
        idempotencyKey: "welcome",
      }),
    ).rejects.toBeInstanceOf(DbConflictError);
    expect(await repos.ledger.listByUser(exec, a.id)).toHaveLength(1);
  });

  it("wallet cannot go negative; optimistic version mismatch returns null", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    await repos.wallets.create(exec, a.id);
    await expect(repos.wallets.adjust(exec, a.id, { available: -1 })).rejects.toBeInstanceOf(
      DbCheckError,
    );
    const credited = await repos.wallets.adjust(exec, a.id, { available: 10 });
    expect(credited?.version).toBe(1);
    expect(
      await repos.wallets.adjust(exec, a.id, { available: -1, expectedVersion: 999 }),
    ).toBeNull();
    const spent = await repos.wallets.adjust(exec, a.id, {
      available: -1,
      reserved: 1,
      expectedVersion: 1,
    });
    expect(spent).toMatchObject({ availableBalance: 9, reservedBalance: 1, version: 2 });
  });

  it("reservation transitions are legal-only", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    const r = await repos.reservations.create(exec, {
      userId: a.id,
      amount: 1,
      requestId: "req-tr-001",
    });
    expect(await repos.reservations.transition(exec, r.id, ["committed"], "released")).toBeNull();
    const committed = await repos.reservations.transition(exec, r.id, ["reserved"], "committed");
    expect(committed?.status).toBe("committed");
    expect(await repos.reservations.transition(exec, r.id, ["reserved"], "released")).toBeNull();
  });

  it("sessions expire and sweep", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    await repos.sessions.create(exec, {
      tokenHash: "h1",
      userId: a.id,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await repos.sessions.create(exec, {
      tokenHash: "h2",
      userId: a.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(await repos.sessions.deleteExpired(exec, "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(await repos.sessions.getByTokenHash(exec, "h1")).toBeNull();
    expect(await repos.sessions.getByTokenHash(exec, "h2")).not.toBeNull();
  });

  it("entitlements grant is idempotent", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    await repos.entitlements.grant(exec, a.id, "premium");
    await repos.entitlements.grant(exec, a.id, "premium");
    expect(await repos.entitlements.listByUser(exec, a.id)).toHaveLength(1);
    expect(await repos.entitlements.has(exec, a.id, "premium")).toBe(true);
    expect(await repos.entitlements.has(exec, a.id, "nope")).toBe(false);
  });

  it("user delete cascades to owned rows", async () => {
    const exec = { query: noop };
    const a = await repos.users.create(exec);
    await repos.identities.create(exec, { userId: a.id, provider: "web", providerUserId: "u1" });
    await repos.wallets.create(exec, a.id);
    await repos.users.deleteById(exec, a.id);
    expect(await repos.users.getById(exec, a.id)).toBeNull();
    expect(await repos.identities.findByProvider(exec, "web", "u1")).toBeNull();
    expect(await repos.wallets.getByUserId(exec, a.id)).toBeNull();
  });
});
