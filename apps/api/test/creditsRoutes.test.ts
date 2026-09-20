import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMemoryRepos, createMemoryStore, type Db, type Repos } from "@user-platform/db";
import { generateServiceToken, hashServiceSecret } from "@user-platform/auth-core";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

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
    telegramBotToken: "t",
    maxBotToken: "m",
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

/** Mint a DB-backed per-app service credential (synthetic, never real). */
async function mintServiceToken(repos: Repos, db: Db, slug: string): Promise<string> {
  const exec = { query: async () => ({ rows: [], rowCount: 0 }) };
  const app = await repos.registry.getAppBySlug(exec, slug);
  if (!app) throw new Error(`unknown app ${slug}`);
  const gen = generateServiceToken();
  await repos.serviceCredentials.create(exec, {
    appId: app.id,
    keyId: gen.keyId,
    secretHash: hashServiceSecret(gen.secret),
    label: `test-${slug}`,
  });
  void db;
  return gen.token;
}

/** Service dev exchange → app session token for a persona (fridge-scoped by default). */
async function appSessionFor(
  app: ReturnType<typeof createApp>,
  serviceToken: string,
  persona: string,
): Promise<string> {
  const ex = await request(app)
    .post("/v1/service/auth/dev/exchange")
    .set("Authorization", `Bearer ${serviceToken}`)
    .send({ persona });
  expect(ex.status).toBe(200);
  expect(ex.body.session.token).toBeTruthy();
  // Service exchange must NOT set a browser cookie.
  expect(ex.headers["set-cookie"]).toBeUndefined();
  return ex.body.session.token as string;
}

describe("POST /v1/credits/* (service==session==operation)", () => {
  it("reserve → commit lifecycle with balances", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const session = await appSessionFor(app, svc, "telegram-user-1");
    const auth = { Authorization: `Bearer ${svc}`, "X-Platform-Session": session };

    const r = await request(app)
      .post("/v1/credits/reserve")
      .set(auth)
      .send({ operation: "fridge.scan", requestId: "http-req-001" });
    expect(r.status).toBe(200);
    expect(r.body.reservation.status).toBe("reserved");
    expect(r.body.reservation.amount).toBe(1);
    expect(r.body.reservation.balance).toEqual({ available: 9, reserved: 1 });
    expect(r.body.reused).toBe(false);

    const retry = await request(app)
      .post("/v1/credits/reserve")
      .set(auth)
      .send({ operation: "fridge.scan", requestId: "http-req-001" });
    expect(retry.body.reused).toBe(true);
    expect(retry.body.reservation.balance).toEqual({ available: 9, reserved: 1 });

    const c = await request(app)
      .post("/v1/credits/commit")
      .set(auth)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(c.status).toBe(200);
    expect(c.body.reservation.status).toBe("committed");
    expect(c.body.reservation.balance).toEqual({ available: 9, reserved: 0 });

    const rel = await request(app)
      .post("/v1/credits/release")
      .set(auth)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(rel.status).toBe(409);
    expect(rel.body.code).toBe("RESERVATION_CONFLICT");
  });

  it("insufficient funds → 402, unknown op → 404, bad body → 400", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const session = await appSessionFor(app, svc, "telegram-user-2");
    const auth = { Authorization: `Bearer ${svc}`, "X-Platform-Session": session };
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post("/v1/credits/reserve")
        .set(auth)
        .send({ operation: "fridge.scan", requestId: `drain-${i}-0000` });
      expect(r.status).toBe(200);
    }
    const poor = await request(app)
      .post("/v1/credits/reserve")
      .set(auth)
      .send({ operation: "fridge.scan", requestId: "drain-11" });
    expect(poor.status).toBe(402);
    expect(poor.body.code).toBe("INSUFFICIENT_CREDITS");

    const unknown = await request(app)
      .post("/v1/credits/reserve")
      .set(auth)
      .send({ operation: "nope.nope", requestId: "x-12345678" });
    expect(unknown.status).toBe(404);

    const bad = await request(app).post("/v1/credits/reserve").set(auth).send({
      operation: "fridge.scan",
    });
    expect(bad.status).toBe(400);
  });

  it("ATTACK: app session without service token → 401", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const session = await appSessionFor(app, svc, "telegram-user-1");
    const res = await request(app)
      .post("/v1/credits/reserve")
      .set("X-Platform-Session", session)
      .send({ operation: "fridge.scan", requestId: "a-12345678" });
    expect(res.status).toBe(401);
  });

  it("ATTACK: service token without user session → 401", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const res = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${svc}`)
      .send({ operation: "fridge.scan", requestId: "b-12345678" });
    expect(res.status).toBe(401);
  });

  it("ATTACK: forged/unknown service token → 401", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const session = await appSessionFor(app, svc, "telegram-user-1");
    const forged = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", "Bearer ups_forgedkey12345678_forgedsecret")
      .set("X-Platform-Session", session)
      .send({ operation: "fridge.scan", requestId: "c-12345678" });
    expect(forged.status).toBe(401);
  });

  it("ATTACK: service cannot spend another user's reservation (IDOR)", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const sessionA = await appSessionFor(app, svc, "telegram-user-1");
    const sessionB = await appSessionFor(app, svc, "telegram-user-2");
    const r = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${svc}`)
      .set("X-Platform-Session", sessionA)
      .send({ operation: "fridge.scan", requestId: "victim-001" });
    expect(r.status).toBe(200);

    const steal = await request(app)
      .post("/v1/credits/commit")
      .set("Authorization", `Bearer ${svc}`)
      .set("X-Platform-Session", sessionB)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(steal.status).toBe(404);
    expect(steal.body.code).toBe("NOT_FOUND");

    // userId smuggled in the body is inert (no such field in the contract).
    const smuggle = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${svc}`)
      .set("X-Platform-Session", sessionB)
      .send({ operation: "fridge.scan", requestId: "smuggle-01", userId: "anything" });
    expect(smuggle.status).toBe(200);
  });

  it("rotation: A+B work, revoke A → A fails, B works", async () => {
    const { app, db, repos } = testContext();
    const exec = { query: async () => ({ rows: [], rowCount: 0 }) };
    const fridge = await repos.registry.getAppBySlug(exec, "fridge");
    if (!fridge) throw new Error("no fridge app");
    const genA = generateServiceToken();
    const genB = generateServiceToken();
    await repos.serviceCredentials.create(exec, {
      appId: fridge.id,
      keyId: genA.keyId,
      secretHash: hashServiceSecret(genA.secret),
      label: "a",
    });
    await repos.serviceCredentials.create(exec, {
      appId: fridge.id,
      keyId: genB.keyId,
      secretHash: hashServiceSecret(genB.secret),
      label: "b",
    });
    void db;
    const sessionA = await appSessionFor(app, genA.token, "telegram-user-1");
    const okA = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${genA.token}`)
      .set("X-Platform-Session", sessionA)
      .send({ operation: "fridge.scan", requestId: "rot-00001" });
    expect(okA.status).toBe(200);
    const sessionB = await appSessionFor(app, genB.token, "telegram-user-1");
    const okB = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${genB.token}`)
      .set("X-Platform-Session", sessionB)
      .send({ operation: "fridge.scan", requestId: "rot-00002" });
    expect(okB.status).toBe(200);

    await repos.serviceCredentials.revokeByKeyId(exec, genA.keyId);
    const dead = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${genA.token}`)
      .set("X-Platform-Session", sessionA)
      .send({ operation: "fridge.scan", requestId: "rot-00003" });
    expect(dead.status).toBe(401);
    const alive = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${genB.token}`)
      .set("X-Platform-Session", sessionB)
      .send({ operation: "fridge.scan", requestId: "rot-00004" });
    expect(alive.status).toBe(200);
  });
});

describe("GET /v1/me/balance + /v1/me/usage", () => {
  it("balance and usage trail with app slugs (account session reads)", async () => {
    const { app, db, repos } = testContext();
    const svc = await mintServiceToken(repos, db, "fridge");
    const session = await appSessionFor(app, svc, "browser-user-1");
    const auth = { Authorization: `Bearer ${svc}`, "X-Platform-Session": session };
    const r = await request(app)
      .post("/v1/credits/reserve")
      .set(auth)
      .send({ operation: "fridge.scan", requestId: "u-00000001" });
    await request(app)
      .post("/v1/credits/commit")
      .set(auth)
      .send({ reservationId: r.body.reservation.reservationId });

    // Account sessions keep READ access: use the browser dev exchange cookie.
    const agent = request.agent(app);
    await agent.post("/v1/auth/dev/exchange").send({ persona: "browser-user-1" });
    const balance = await agent.get("/v1/me/balance");
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({ available: 9, reserved: 0 });

    const usage = await agent.get("/v1/me/usage");
    expect(usage.status).toBe(200);
    expect(
      usage.body.usage
        .map((u: { operation: string; status: string }) => `${u.operation}:${u.status}`)
        .sort(),
    ).toEqual(["fridge.scan:committed", "fridge.scan:reserved"]);
    expect(usage.body.usage[0].appSlug).toBe("fridge");

    const limited = await agent.get("/v1/me/usage?limit=1");
    expect(limited.body.usage).toHaveLength(1);

    expect((await request(app).get("/v1/me/balance")).status).toBe(401);
    expect((await request(app).get("/v1/me/usage")).status).toBe(401);
  });
});
