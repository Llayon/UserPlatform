import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMemoryRepos, createMemoryStore, type Db } from "@user-platform/db";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const SERVICE = "svc-test-token-1234567890";

function testApp(overrides: Partial<ApiConfig> = {}) {
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
    serviceToken: SERVICE,
    serviceTokenPrevious: "",
    ...overrides,
  };
  return createApp({ config, db, repos: createMemoryRepos(createMemoryStore()) });
}

async function agentWithCredits(app: ReturnType<typeof testApp>, persona: string) {
  const agent = request.agent(app);
  const ex = await agent.post("/v1/auth/dev/exchange").send({ persona });
  expect(ex.status).toBe(200);
  return agent;
}

describe("POST /v1/credits/* (dual binding)", () => {
  it("reserve → commit lifecycle with balances", async () => {
    const app = testApp();
    const agent = await agentWithCredits(app, "telegram-user-1");
    const r = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "http-req-001" });
    expect(r.status).toBe(200);
    expect(r.body.reservation.status).toBe("reserved");
    expect(r.body.reservation.amount).toBe(1);
    expect(r.body.reservation.balance).toEqual({ available: 9, reserved: 1 });
    expect(r.body.reused).toBe(false);

    const retry = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "http-req-001" });
    expect(retry.body.reused).toBe(true);
    expect(retry.body.reservation.balance).toEqual({ available: 9, reserved: 1 });

    const c = await agent
      .post("/v1/credits/commit")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(c.status).toBe(200);
    expect(c.body.reservation.status).toBe("committed");
    expect(c.body.reservation.balance).toEqual({ available: 9, reserved: 0 });

    const rel = await agent
      .post("/v1/credits/release")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(rel.status).toBe(409);
    expect(rel.body.code).toBe("RESERVATION_CONFLICT");
  });

  it("insufficient funds → 402, unknown op → 404, bad body → 400", async () => {
    const app = testApp();
    const agent = await agentWithCredits(app, "telegram-user-2");
    for (let i = 0; i < 10; i++) {
      const r = await agent
        .post("/v1/credits/reserve")
        .set("Authorization", `Bearer ${SERVICE}`)
        .send({ operation: "fridge.scan", requestId: `drain-${i}-0000` });
      expect(r.status).toBe(200);
    }
    const poor = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "drain-11" });
    expect(poor.status).toBe(402);
    expect(poor.body.code).toBe("INSUFFICIENT_CREDITS");

    const unknown = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "nope.nope", requestId: "x-12345678" });
    expect(unknown.status).toBe(404);

    const bad = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan" });
    expect(bad.status).toBe(400);
  });

  it("ATTACK: session without service token → 401", async () => {
    const app = testApp();
    const agent = await agentWithCredits(app, "telegram-user-1");
    const res = await agent
      .post("/v1/credits/reserve")
      .send({ operation: "fridge.scan", requestId: "a-12345678" });
    expect(res.status).toBe(401);
  });

  it("ATTACK: service token without user session → 401", async () => {
    const res = await request(testApp())
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "b-12345678" });
    expect(res.status).toBe(401);
  });

  it("ATTACK: forged service token → 401, unconfigured service → 401", async () => {
    const app = testApp();
    const agent = await agentWithCredits(app, "telegram-user-1");
    const forged = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", "Bearer forged-token-xyz")
      .send({ operation: "fridge.scan", requestId: "c-12345678" });
    expect(forged.status).toBe(401);

    const open = testApp({ serviceToken: "", serviceTokenPrevious: "" });
    const openAgent = await agentWithCredits(open, "telegram-user-1");
    const res = await openAgent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "d-12345678" });
    expect(res.status).toBe(401);
  });

  it("ATTACK: service cannot spend another user's reservation (IDOR)", async () => {
    const app = testApp();
    const agentA = await agentWithCredits(app, "telegram-user-1");
    const agentB = await agentWithCredits(app, "telegram-user-2");
    const r = await agentA
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "victim-001" });
    expect(r.status).toBe(200);

    const steal = await agentB
      .post("/v1/credits/commit")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ reservationId: r.body.reservation.reservationId });
    expect(steal.status).toBe(404);
    expect(steal.body.code).toBe("NOT_FOUND");

    // userId smuggled in the body is inert (no such field in the contract).
    const smuggle = await agentB
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "smuggle-01", userId: "anything" });
    expect(smuggle.status).toBe(200);
    const meB = await agentB.get("/v1/me");
    expect(smuggle.body.reservation.balance.available).toBe(meB.body.balance.available);
  });

  it("rotation: previous token honored, garbage rejected", async () => {
    const app = testApp({ serviceToken: "svc-new", serviceTokenPrevious: "svc-old" });
    const agent = await agentWithCredits(app, "telegram-user-1");
    const ok = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", "Bearer svc-old")
      .send({ operation: "fridge.scan", requestId: "rot-00001" });
    expect(ok.status).toBe(200);
    const bad = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", "Bearer svc-ancient")
      .send({ operation: "fridge.scan", requestId: "rot-00002" });
    expect(bad.status).toBe(401);
  });

  it("user session travels via X-Platform-Session header too", async () => {
    const app = testApp();
    const ex = await request(app).post("/v1/auth/dev/exchange").send({ persona: "max-user-1" });
    expect(ex.status).toBe(200);
    const setCookie = ex.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    const token = decodeURIComponent(raw.split(";")[0].split("=")[1]);
    // Fresh client with NO cookie jar: session rides the header instead.
    const me = await request(app).get("/v1/me").set("X-Platform-Session", token);
    expect(me.status).toBe(200);
    expect(me.body.balance.available).toBe(10);
    const r = await request(app)
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .set("X-Platform-Session", token)
      .send({ operation: "fridge.scan", requestId: "hdr-000001" });
    expect(r.status).toBe(200);
  });
});

describe("GET /v1/me/balance + /v1/me/usage", () => {
  it("balance and usage trail with app slugs", async () => {
    const app = testApp();
    const agent = await agentWithCredits(app, "browser-user-1");
    const r = await agent
      .post("/v1/credits/reserve")
      .set("Authorization", `Bearer ${SERVICE}`)
      .send({ operation: "fridge.scan", requestId: "u-00000001" });
    await agent.post("/v1/credits/commit").set("Authorization", `Bearer ${SERVICE}`).send({
      reservationId: r.body.reservation.reservationId,
    });

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
