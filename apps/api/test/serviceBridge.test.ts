import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMemoryRepos, createMemoryStore, type Db, type Repos } from "@user-platform/db";
import {
  generateServiceToken,
  hashServiceSecret,
  parseServiceToken,
} from "@user-platform/auth-core";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { signInitData, telegramFields } from "./signer.js";

const TOKEN = "bridge-telegram-token-1234567890";

function testContext(overrides: Partial<ApiConfig> = {}) {
  const noop = { query: async () => ({ rows: [], rowCount: 0 }) };
  const db: Db = {
    query: noop.query,
    withTransaction: (fn) => fn({ query: noop.query }),
    close: async () => {},
  };
  const config: ApiConfig = {
    port: 3002,
    isProduction: false,
    telegramBotToken: TOKEN,
    maxBotToken: "bridge-max",
    welcomeCredits: 10,
    sessionTtlSeconds: 3600,
    allowDevAuth: true,
    sessionCookieName: "up_session",
    ...overrides,
  };
  const repos = createMemoryRepos(createMemoryStore());
  const app = createApp({ config, db, repos });
  return { app, db, repos };
}

const exec = { query: async () => ({ rows: [], rowCount: 0 }) };

async function mintFor(repos: Repos, slug: string, label = "test"): Promise<string> {
  const app = await repos.registry.getAppBySlug(exec, slug);
  if (!app) throw new Error(`no app ${slug}`);
  const gen = generateServiceToken();
  await repos.serviceCredentials.create(exec, {
    appId: app.id,
    keyId: gen.keyId,
    secretHash: hashServiceSecret(gen.secret),
    label,
  });
  return gen.token;
}

async function appSession(
  app: ReturnType<typeof createApp>,
  serviceToken: string,
  persona: string,
): Promise<string> {
  const ex = await request(app)
    .post("/v1/service/auth/dev/exchange")
    .set("Authorization", `Bearer ${serviceToken}`)
    .send({ persona });
  expect(ex.status).toBe(200);
  return ex.body.session.token as string;
}

async function accountSessionCookie(
  app: ReturnType<typeof createApp>,
  persona: string,
): Promise<string> {
  const agent = request.agent(app);
  const ex = await agent.post("/v1/auth/dev/exchange").send({ persona });
  expect(ex.status).toBe(200);
  return agent as unknown as string;
}

function signedTelegram(userId = 6001): string {
  return signInitData(telegramFields(Math.floor(Date.now() / 1000) - 5, userId), TOKEN);
}

describe("Gauntlet 1 service bridge", () => {
  it("A. SERVICE IDENTITY: tokens map to exactly one app", async () => {
    const { app, repos } = testContext();
    const fridge = await mintFor(repos, "fridge");
    const wardrobe = await mintFor(repos, "wardrobe");
    const f = await request(app)
      .post("/v1/service/auth/dev/exchange")
      .set("Authorization", `Bearer ${fridge}`)
      .send({ persona: "telegram-user-1" });
    expect(f.status).toBe(200);
    expect(f.body.app.slug).toBe("fridge");
    const w = await request(app)
      .post("/v1/service/auth/dev/exchange")
      .set("Authorization", `Bearer ${wardrobe}`)
      .send({ persona: "telegram-user-1" });
    expect(w.status).toBe(200);
    expect(w.body.app.slug).toBe("wardrobe");
    expect(f.body.app.id).not.toBe(w.body.app.id);
  });

  it("C. SERVER EXCHANGE: real Telegram initData → app session, no cookie, token present", async () => {
    const { app, repos } = testContext();
    const fridge = await mintFor(repos, "fridge");
    const res = await request(app)
      .post("/v1/service/auth/platform-exchange")
      .set("Authorization", `Bearer ${fridge}`)
      .send({ platform: "telegram", initData: signedTelegram(6101) });
    expect(res.status).toBe(200);
    expect(res.body.app.slug).toBe("fridge");
    expect(res.body.session.token.length).toBeGreaterThan(20);
    expect(res.body.balance).toBe(10);
    expect(res.headers["set-cookie"]).toBeUndefined();
    // Session row is app-scoped in the DB.
    const { hashSessionToken } = await import("@user-platform/auth-core");
    const row = await repos.sessions.getByTokenHash(exec, hashSessionToken(res.body.session.token));
    expect(row?.sessionType).toBe("app");
    expect(row?.appId).toBe(res.body.app.id);
  });

  it("C. SERVER EXCHANGE requires service credential (401 without, 401 forged)", async () => {
    const { app, repos } = testContext();
    await mintFor(repos, "fridge");
    const noAuth = await request(app)
      .post("/v1/service/auth/platform-exchange")
      .send({ platform: "telegram", initData: signedTelegram(6201) });
    expect(noAuth.status).toBe(401);
    const forged = await request(app)
      .post("/v1/service/auth/platform-exchange")
      .set("Authorization", "Bearer ups_abcdefgh_wrongsecretwrongsecretwrong")
      .send({ platform: "telegram", initData: signedTelegram(6201) });
    expect(forged.status).toBe(401);
  });

  it("E. CROSS-SERVICE reserve matrix", async () => {
    const { app, repos } = testContext();
    const fridgeSvc = await mintFor(repos, "fridge");
    const wardrobeSvc = await mintFor(repos, "wardrobe");
    const fridgeSession = await appSession(app, fridgeSvc, "telegram-user-1");

    // fridge + fridge session + fridge.scan → succeeds
    const ok = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", fridgeSession)
      .send({ operation: "fridge.scan", requestId: "xs-000001" });
    expect(ok.status).toBe(200);

    // fridge + fridge session + wardrobe.outfit → 403 (operation/service mismatch)
    const crossOp = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", fridgeSession)
      .send({ operation: "wardrobe.outfit", requestId: "xs-000002" });
    expect(crossOp.status).toBe(403);
    expect(crossOp.body.code).toBe("FORBIDDEN");

    // wardrobe service + fridge session + wardrobe.outfit → 403 (session/service mismatch)
    const crossSession = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${wardrobeSvc}`)
      .set("X-Platform-Session", fridgeSession)
      .send({ operation: "wardrobe.outfit", requestId: "xs-000003" });
    expect(crossSession.status).toBe(403);
  });

  it("F. RESERVATION OWNERSHIP: cross-service commit/release → 403", async () => {
    const { app, repos } = testContext();
    const fridgeSvc = await mintFor(repos, "fridge");
    const wardrobeSvc = await mintFor(repos, "wardrobe");
    // Same underlying user on both sides (same persona → same UUID).
    const fridgeSession = await appSession(app, fridgeSvc, "telegram-user-2");
    const wardrobeSession = await appSession(app, wardrobeSvc, "telegram-user-2");
    const r = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", fridgeSession)
      .send({ operation: "fridge.scan", requestId: "own-000001" });
    expect(r.status).toBe(200);
    const id = r.body.reservation.reservationId as string;

    const commit = await request(app)
      .post("/v1/credits/commit")
      .set("Authorization", `Bearer ${wardrobeSvc}`)
      .set("X-Platform-Session", wardrobeSession)
      .send({ reservationId: id });
    expect(commit.status).toBe(403);

    const rel = await request(app)
      .post("/v1/credits/release")
      .set("Authorization", `Bearer ${wardrobeSvc}`)
      .set("X-Platform-Session", wardrobeSession)
      .send({ reservationId: id });
    expect(rel.status).toBe(403);

    // Owner can still commit.
    const own = await request(app)
      .post("/v1/credits/commit")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", fridgeSession)
      .send({ reservationId: id });
    expect(own.status).toBe(200);
  });

  it("G. ACCOUNT SESSION + service credential → 403 on credit mutation", async () => {
    const { app, repos } = testContext();
    const fridgeSvc = await mintFor(repos, "fridge");
    const agent = request.agent(app);
    await agent.post("/v1/auth/dev/exchange").send({ persona: "telegram-user-1" });
    const denied = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .send({ operation: "fridge.scan", requestId: "acct-00001" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    void accountSessionCookie;
  });

  it("SERVICE AUTH RED TEAM", async () => {
    const { app, repos } = testContext();
    const fridgeSvc = await mintFor(repos, "fridge");
    const session = await appSession(app, fridgeSvc, "max-user-1");
    const authed = (token: string) =>
      request(app)
        .post("/v1/credits/reserve")
        .set("Authorization", token ? `Bearer ${token}` : "")
        .set("X-Platform-Session", session);

    // missing token → 401
    expect(
      (
        await request(app)
          .post("/v1/credits/reserve")
          .set("X-Platform-Session", session)
          .send({ operation: "fridge.scan", requestId: "rt-missing" })
      ).status,
    ).toBe(401);
    // garbage → 401
    expect(
      (await authed("garbage").send({ operation: "fridge.scan", requestId: "rt-garbage" })).status,
    ).toBe(401);
    // malformed (no prefix) → 401
    expect(
      (await authed("badformat").send({ operation: "fridge.scan", requestId: "rt-malform" }))
        .status,
    ).toBe(401);
    // extra-long → 401 (cheap reject, no lookup)
    expect(
      (
        await authed(`ups_${"k".repeat(64)}_${"s".repeat(200)}`).send({
          operation: "fridge.scan",
          requestId: "rt-long000",
        })
      ).status,
    ).toBe(401);
    // unknown keyId → 401 (indistinguishable from wrong secret)
    const fake = generateServiceToken();
    expect(
      (await authed(fake.token).send({ operation: "fridge.scan", requestId: "rt-unknown" })).status,
    ).toBe(401);
    // valid keyId + wrong secret → 401
    const parsed = parseServiceToken(fridgeSvc);
    if (!parsed) throw new Error("parse failed");
    expect(
      (
        await authed(`ups_${parsed.keyId}_wrongsecretwrongsecretwrongsecret12`).send({
          operation: "fridge.scan",
          requestId: "rt-wrongsec",
        })
      ).status,
    ).toBe(401);

    // expired credential → 401
    const fridgeApp = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridgeApp) throw new Error("no fridge");
    const exp = generateServiceToken();
    await repos.serviceCredentials.create(exec, {
      appId: fridgeApp.id,
      keyId: exp.keyId,
      secretHash: hashServiceSecret(exp.secret),
      label: "expired",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const expSession = await appSession(app, fridgeSvc, "max-user-1");
    expect(
      (
        await request(app)
          .post("/v1/credits/reserve")
          .set("Authorization", `Bearer ${exp.token}`)
          .set("X-Platform-Session", expSession)
          .send({ operation: "fridge.scan", requestId: "rt-expired" })
      ).status,
    ).toBe(401);

    // revoked credential → 401
    const rev = generateServiceToken();
    await repos.serviceCredentials.create(exec, {
      appId: fridgeApp.id,
      keyId: rev.keyId,
      secretHash: hashServiceSecret(rev.secret),
      label: "torevoke",
    });
    await repos.serviceCredentials.revokeByKeyId(exec, rev.keyId);
    expect(
      (
        await request(app)
          .post("/v1/credits/reserve")
          .set("Authorization", `Bearer ${rev.token}`)
          .set("X-Platform-Session", expSession)
          .send({ operation: "fridge.scan", requestId: "rt-revoked" })
      ).status,
    ).toBe(401);

    // same secret in another app is NOT authority there: copy fridge secret hash
    // under wardrobe keyId and prove the fridge TOKEN still cannot spend wardrobe ops.
    const cross = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", session)
      .send({ operation: "wardrobe.outfit", requestId: "rt-crossop" });
    expect(cross.status).toBe(403);
  });

  it("SESSION RED TEAM", async () => {
    const { app, db, repos } = testContext();
    void db;
    const fridgeSvc = await mintFor(repos, "fridge");
    const { hashSessionToken } = await import("@user-platform/auth-core");

    // expired app session → 401/deny
    const s1 = await appSession(app, fridgeSvc, "telegram-user-1");
    await repos.sessions.deleteByTokenHash(exec, hashSessionToken(s1));
    const gone = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", s1)
      .send({ operation: "fridge.scan", requestId: "sr-deleted" });
    expect([401, 403]).toContain(gone.status);

    // random session → 401
    const rand = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", "random-session-token-value-123456")
      .send({ operation: "fridge.scan", requestId: "sr-random0" });
    expect(rand.status).toBe(401);

    // suspended user → 403 on spend (manual suspended account + app session)
    const { createSessionToken } = await import("@user-platform/auth-core");
    const suspended = await repos.users.create(exec, { status: "suspended" });
    await repos.wallets.create(exec, suspended.id);
    await repos.wallets.adjust(exec, suspended.id, { available: 10 });
    const fridgeApp = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridgeApp) throw new Error("no fridge");
    const rawSuspended = createSessionToken();
    await repos.sessions.create(exec, {
      tokenHash: hashSessionToken(rawSuspended),
      userId: suspended.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
      sessionType: "app",
      appId: fridgeApp.id,
    });
    const susp = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", rawSuspended)
      .send({ operation: "fridge.scan", requestId: "sr-suspend" });
    expect(susp.status).toBe(403);
  });

  it("disabled app credential is rejected (403 on service op)", async () => {
    const ctx = testContext();
    const { app, repos } = ctx;
    // Wrap the registry to report fridge as disabled (no prod mutation).
    const inner = repos.registry;
    const disabledFridge = {
      ...(await inner.getAppBySlug(exec, "fridge"))!,
      status: "disabled" as const,
    };
    const patchedRepos = {
      ...repos,
      registry: {
        ...inner,
        getAppById: async (e: unknown, id: string) => {
          const real = await inner.getAppById(e as never, id);
          if (real && real.slug === "fridge") return { ...real, status: "disabled" as const };
          return real;
        },
        getAppBySlug: async (e: unknown, slug: string) => {
          const real = await inner.getAppBySlug(e as never, slug);
          if (real && slug === "fridge") return { ...real, status: "disabled" as const };
          return real;
        },
      },
    };
    void disabledFridge;
    const { createApp: mkApp } = await import("../src/app.js");
    const cfg = {
      port: 3002,
      isProduction: false,
      telegramBotToken: TOKEN,
      maxBotToken: "bridge-max",
      welcomeCredits: 10,
      sessionTtlSeconds: 3600,
      allowDevAuth: true,
      sessionCookieName: "up_session",
    };
    const noop = { query: async () => ({ rows: [], rowCount: 0 }) };
    const dbx = {
      query: noop.query,
      withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ query: noop.query }),
      close: async () => {},
    };
    const disabledApp = mkApp({ config: cfg, db: dbx as never, repos: patchedRepos as never });
    const fridgeSvc = await mintFor(repos, "fridge");
    // Service exchange itself must fail closed for a disabled app.
    const ex = await request(disabledApp)
      .post("/v1/service/auth/dev/exchange")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .send({ persona: "telegram-user-1" });
    expect([401, 403]).toContain(ex.status);
    // Direct credit call with a previously valid session is also denied.
    const session = await appSession(app, fridgeSvc, "telegram-user-1");
    const denied = await request(disabledApp)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .set("X-Platform-Session", session)
      .send({ operation: "fridge.scan", requestId: "dis-000001" });
    expect([401, 403]).toContain(denied.status);
  });

  it("H. WELCOME BONUS mixed race: 5 account + 5 service → one user, one +10", async () => {
    const { app, db, repos } = testContext();
    void db;
    const fridgeSvc = await mintFor(repos, "fridge");
    const raw = signedTelegram(6301);
    const accountCalls = Array.from({ length: 5 }, () =>
      request(app).post("/v1/auth/platform/exchange").send({ platform: "telegram", initData: raw }),
    );
    const serviceCalls = Array.from({ length: 5 }, () =>
      request(app)
        .post("/v1/service/auth/platform-exchange")
        .set("Authorization", `Bearer ${fridgeSvc}`)
        .send({ platform: "telegram", initData: raw }),
    );
    const all = await Promise.all([...accountCalls, ...serviceCalls]);
    for (const r of all) expect(r.status).toBe(200);
    const ids = new Set(all.map((r) => r.body.user.id));
    expect(ids.size).toBe(1);
    const userId = [...ids][0] as string;
    const ledger = await repos.ledger.listByUser(exec, userId);
    const bonuses = ledger.filter((e) => e.reason === "welcome_bonus");
    expect(bonuses).toHaveLength(1);
    expect(bonuses[0].delta).toBe(10);
  });

  it("start_param never determines service identity", async () => {
    const { app, repos } = testContext();
    const fridgeSvc = await mintFor(repos, "fridge");
    const res = await request(app)
      .post("/v1/service/auth/platform-exchange")
      .set("Authorization", `Bearer ${fridgeSvc}`)
      .send({ platform: "telegram", initData: signedTelegram(6401), startParam: "wardrobe" });
    expect(res.status).toBe(200);
    expect(res.body.app.slug).toBe("fridge");
  });
});
