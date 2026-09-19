import { describe, it, expect, beforeEach } from "vitest";
import {
  createMemoryRepos,
  createMemoryStore,
  type Db,
  type DbExecutor,
  type Repos,
} from "@user-platform/db";
import { CreditError, commit, getBalance, release, releaseStale, reserve } from "../src/engine.js";

const noopExec: DbExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

function memDeps(): { db: Db; repos: Repos } {
  const repos = createMemoryRepos(createMemoryStore());
  const db: Db = {
    query: noopExec.query,
    withTransaction: (fn) => fn({ query: noopExec.query }),
    close: async () => {},
  };
  return { db, repos };
}

async function fundedUser(repos: Repos, amount = 10): Promise<string> {
  const u = await repos.users.create(noopExec, {});
  await repos.wallets.create(noopExec, u.id);
  await repos.wallets.adjust(noopExec, u.id, { available: amount });
  return u.id;
}

let deps: ReturnType<typeof memDeps>;
beforeEach(() => {
  deps = memDeps();
});

describe("credit gauntlet §45 (memory)", () => {
  it("welcome 10 → reserve → commit → 9; commit retry is a no-op", async () => {
    const userId = await fundedUser(deps.repos, 10);
    const r = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-001" });
    expect(r.reused).toBe(false);
    expect(r.balance).toEqual({ available: 9, reserved: 1 });

    const c = await commit(deps, { userId, reservationId: r.reservation.id });
    expect(c.reused).toBe(false);
    expect(c.balance).toEqual({ available: 9, reserved: 0 });

    const retry = await commit(deps, { userId, reservationId: r.reservation.id });
    expect(retry.reused).toBe(true);
    expect(retry.balance).toEqual({ available: 9, reserved: 0 });

    const ledger = await deps.repos.ledger.listByUser(noopExec, userId);
    expect(ledger.filter((e) => e.reason === "commit")).toHaveLength(1);
    expect(await getBalance(deps, userId)).toEqual({ available: 9, reserved: 0 });
    const usage = await deps.repos.usage.listByUser(noopExec, userId);
    expect(usage.map((u) => `${u.operation}:${u.status}`).sort()).toEqual([
      "fridge.scan:committed",
      "fridge.scan:reserved",
    ]);
  });

  it("reserve → release → balance restored; release retry is a no-op", async () => {
    const userId = await fundedUser(deps.repos, 10);
    const r = await reserve(deps, { userId, operation: "wardrobe.outfit", requestId: "req-002" });
    expect(r.balance).toEqual({ available: 9, reserved: 1 });

    const rel = await release(deps, { userId, reservationId: r.reservation.id });
    expect(rel.reused).toBe(false);
    expect(rel.balance).toEqual({ available: 10, reserved: 0 });

    const retry = await release(deps, { userId, reservationId: r.reservation.id });
    expect(retry.reused).toBe(true);
    expect(retry.balance).toEqual({ available: 10, reserved: 0 });

    // Release writes no ledger row (net movement zero; trail is in usage).
    const ledger = await deps.repos.ledger.listByUser(noopExec, userId);
    expect(ledger).toHaveLength(0);
  });

  it("same requestId retried returns the same reservation without new charge", async () => {
    const userId = await fundedUser(deps.repos, 10);
    const first = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-dup" });
    const second = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-dup" });
    expect(second.reused).toBe(true);
    expect(second.reservation.id).toBe(first.reservation.id);
    expect(second.balance).toEqual({ available: 9, reserved: 1 });
  });

  it("insufficient balance rejects before any provider work, persisting nothing", async () => {
    const userId = await fundedUser(deps.repos, 0);
    await expect(
      reserve(deps, { userId, operation: "fridge.scan", requestId: "req-poor" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await deps.repos.reservations.getByUserRequest(noopExec, userId, "req-poor")).toBeNull();
    const usage = await deps.repos.usage.listByUser(noopExec, userId);
    expect(usage).toHaveLength(0);
  });

  it("unknown operation and foreign reservation are rejected; no cross-user access", async () => {
    const userId = await fundedUser(deps.repos, 10);
    await expect(
      reserve(deps, { userId, operation: "nope.nope", requestId: "req-x" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OPERATION" });
    await expect(
      commit(deps, { userId, reservationId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({
      code: "RESERVATION_NOT_FOUND",
    });

    const other = await fundedUser(deps.repos, 10);
    const r = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-mine" });
    await expect(
      commit(deps, { userId: other, reservationId: r.reservation.id }),
    ).rejects.toMatchObject({
      code: "RESERVATION_NOT_FOUND",
    });
  });

  it("commit-after-release and release-after-commit are illegal transitions", async () => {
    const userId = await fundedUser(deps.repos, 10);
    const r1 = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-a" });
    await release(deps, { userId, reservationId: r1.reservation.id });
    await expect(commit(deps, { userId, reservationId: r1.reservation.id })).rejects.toMatchObject({
      code: "RESERVATION_STATE",
    });

    const r2 = await reserve(deps, { userId, operation: "fridge.scan", requestId: "req-b" });
    await commit(deps, { userId, reservationId: r2.reservation.id });
    await expect(release(deps, { userId, reservationId: r2.reservation.id })).rejects.toMatchObject(
      {
        code: "RESERVATION_STATE",
      },
    );
  });

  it("zero-cost operation flows without moving money", async () => {
    const userId = await fundedUser(deps.repos, 10);
    const r = await reserve(deps, { userId, operation: "fridge.recipe", requestId: "req-free" });
    expect(r.balance).toEqual({ available: 10, reserved: 0 });
    const c = await commit(deps, { userId, reservationId: r.reservation.id });
    expect(c.balance).toEqual({ available: 10, reserved: 0 });
  });

  it("missing wallet reads as zero; stale reservations are recoverable", async () => {
    const ghost = await deps.repos.users.create(noopExec, {});
    expect(await getBalance(deps, ghost.id)).toEqual({ available: 0, reserved: 0 });

    const userId = await fundedUser(deps.repos, 5);
    await reserve(deps, { userId, operation: "interior.analyze", requestId: "req-stale" });
    expect(await getBalance(deps, userId)).toEqual({ available: 3, reserved: 2 });
    // Explicit clock: cutoff strictly after creation (avoids same-ms flake).
    expect(await releaseStale(deps, 0, Date.now() + 5000)).toBe(1);
    expect(await getBalance(deps, userId)).toEqual({ available: 5, reserved: 0 });
    expect(await releaseStale(deps, 0)).toBe(0);
  });

  it("CreditError carries machine codes", () => {
    expect(new CreditError("INSUFFICIENT_CREDITS", "x").code).toBe("INSUFFICIENT_CREDITS");
  });

  it("suspended accounts cannot spend, but reads stay open", async () => {
    const suspended = await deps.repos.users.create(noopExec, { status: "suspended" });
    await deps.repos.wallets.create(noopExec, suspended.id);
    await deps.repos.wallets.adjust(noopExec, suspended.id, { available: 10 });
    await expect(
      reserve(deps, { userId: suspended.id, operation: "fridge.scan", requestId: "req-susp" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED" });
    expect(await getBalance(deps, suspended.id)).toEqual({ available: 10, reserved: 0 });
  });
});
