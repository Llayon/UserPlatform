import { describe, it, expect, beforeEach } from "vitest";
import { DbCheckError, DbConflictError, DbForeignKeyError } from "../src/executor.js";
import { createMemoryRepos, createMemoryStore } from "../src/memory.js";

describe("service bridge DB authority (memory parity)", () => {
  const noop = async () => ({ rows: [], rowCount: 0 });
  const exec = { query: noop };
  let repos: ReturnType<typeof createMemoryRepos>;

  beforeEach(() => {
    repos = createMemoryRepos(createMemoryStore());
  });

  it("service credential requires a valid app FK", async () => {
    await expect(
      repos.serviceCredentials.create(exec, {
        appId: "00000000-0000-0000-0000-000000000000",
        keyId: "testkeyid12345678",
        secretHash: "hash",
      }),
    ).rejects.toBeInstanceOf(DbForeignKeyError);
  });

  it("duplicate key_id rejected", async () => {
    const fridge = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridge) throw new Error("no fridge");
    await repos.serviceCredentials.create(exec, {
      appId: fridge.id,
      keyId: "dupkeyid12345678",
      secretHash: "h1",
    });
    const wardrobe = await repos.registry.getAppBySlug(exec, "wardrobe");
    if (!wardrobe) throw new Error("no wardrobe");
    await expect(
      repos.serviceCredentials.create(exec, {
        appId: wardrobe.id,
        keyId: "dupkeyid12345678",
        secretHash: "h2",
      }),
    ).rejects.toBeInstanceOf(DbConflictError);
  });

  it("account session with app_id rejected; app session without app_id rejected", async () => {
    const user = await repos.users.create(exec);
    const fridge = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridge) throw new Error("no fridge");
    await expect(
      repos.sessions.create(exec, {
        tokenHash: "h-acct-bad",
        userId: user.id,
        expiresAt: "2999-01-01T00:00:00.000Z",
        sessionType: "account",
        appId: fridge.id,
      }),
    ).rejects.toBeInstanceOf(DbCheckError);
    await expect(
      repos.sessions.create(exec, {
        tokenHash: "h-app-bad",
        userId: user.id,
        expiresAt: "2999-01-01T00:00:00.000Z",
        sessionType: "app",
        appId: null,
      }),
    ).rejects.toBeInstanceOf(DbCheckError);
    const okAcct = await repos.sessions.create(exec, {
      tokenHash: "h-acct-ok",
      userId: user.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(okAcct.sessionType).toBe("account");
    expect(okAcct.appId).toBeNull();
    const okApp = await repos.sessions.create(exec, {
      tokenHash: "h-app-ok",
      userId: user.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
      sessionType: "app",
      appId: fridge.id,
    });
    expect(okApp.sessionType).toBe("app");
  });

  it("getAppBySlug resolves fridge/wardrobe", async () => {
    expect((await repos.registry.getAppBySlug(exec, "fridge"))?.slug).toBe("fridge");
    expect((await repos.registry.getAppBySlug(exec, "wardrobe"))?.slug).toBe("wardrobe");
    expect(await repos.registry.getAppBySlug(exec, "nope")).toBeNull();
  });

  it("revoke is idempotent-safe (second revoke returns null)", async () => {
    const fridge = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridge) throw new Error("no fridge");
    await repos.serviceCredentials.create(exec, {
      appId: fridge.id,
      keyId: "revokekey12345678",
      secretHash: "h",
    });
    expect(await repos.serviceCredentials.revokeByKeyId(exec, "revokekey12345678")).not.toBeNull();
    expect(await repos.serviceCredentials.revokeByKeyId(exec, "revokekey12345678")).toBeNull();
  });
});
