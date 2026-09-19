import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMemoryRepos, createMemoryStore, type Db } from "@user-platform/db";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { signInitData, telegramFields } from "./signer.js";

const TOKEN = "test-telegram-token-1234567890";

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
    telegramBotToken: TOKEN,
    maxBotToken: "test-max",
    welcomeCredits: 10,
    sessionTtlSeconds: 3600,
    allowDevAuth: true,
    sessionCookieName: "up_session",
    serviceToken: "test-service-token",
    serviceTokenPrevious: "",
    ...overrides,
  };
  return createApp({ config, db, repos: createMemoryRepos(createMemoryStore()) });
}

function signedTelegram(userId = 5555, ageSeconds = 5): string {
  return signInitData(telegramFields(Math.floor(Date.now() / 1000) - ageSeconds, userId), TOKEN);
}

function cookies(res: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join(";") : (raw ?? "");
}

describe("POST /v1/auth/platform/exchange", () => {
  it("new user: 200, welcome balance, HttpOnly session cookie", async () => {
    const app = testApp();
    const res = await request(app)
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram() });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.balance).toBe(10);
    expect(res.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    const cookie = cookies(res);
    expect(cookie).toContain("up_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("returning user: same UUID, no bonus", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const first = await agent
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(7777) });
    const second = await agent
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(7777) });
    expect(second.body.isNewUser).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.balance).toBe(10);
  });

  it("tampered initData → 400 INVALID_PLATFORM_DATA", async () => {
    const res = await request(testApp())
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram().replace("5555", "6666") });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PLATFORM_DATA");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("expired initData → 401 PLATFORM_DATA_EXPIRED", async () => {
    const res = await request(testApp())
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(5555, 7200) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("PLATFORM_DATA_EXPIRED");
  });

  it("malformed body → 400 INVALID_PAYLOAD", async () => {
    const res = await request(testApp())
      .post("/v1/auth/platform/exchange")
      .send({ platform: "email", initData: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /v1/me + DELETE /v1/auth/session", () => {
  it("me works with cookie, 401 without, 401 after logout", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await agent
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(8888) });
    const me = await agent.get("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.balance).toEqual({ available: 10, reserved: 0 });
    expect(me.body.profile.displayName).toBeTruthy();
    expect(await request(app).get("/v1/me")).toMatchObject({ status: 401 });
    const logout = await agent.delete("/v1/auth/session");
    expect(logout.status).toBe(204);
    expect(await agent.get("/v1/me")).toMatchObject({ status: 401 });
  });

  it("sessions are bound: agent A cannot read agent B (no user param exists)", async () => {
    const app = testApp();
    const agentA = request.agent(app);
    const agentB = request.agent(app);
    const resA = await agentA
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(1111) });
    const resB = await agentB
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(2222) });
    expect(resA.body.user.id).not.toBe(resB.body.user.id);
    const meA = await agentA.get("/v1/me");
    const meB = await agentB.get("/v1/me");
    expect(meA.body.user.id).toBe(resA.body.user.id);
    expect(meB.body.user.id).toBe(resB.body.user.id);
  });
});

describe("dev exchange gating", () => {
  it("allows personas in dev, 404s when disabled", async () => {
    const ok = await request(testApp())
      .post("/v1/auth/dev/exchange")
      .send({ persona: "telegram-user-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(10);
    const bad = await request(testApp()).post("/v1/auth/dev/exchange").send({ persona: "nope" });
    expect(bad.status).toBe(400);
    const prod = await request(testApp({ allowDevAuth: false, isProduction: true }))
      .post("/v1/auth/dev/exchange")
      .send({ persona: "telegram-user-1" });
    expect(prod.status).toBe(404);
  });

  it("dev cookies are Lax without Secure; prod cookies are None+Secure", async () => {
    const devRes = await request(testApp())
      .post("/v1/auth/dev/exchange")
      .send({ persona: "max-user-1" });
    const devCookie = cookies(devRes);
    expect(devCookie).toMatch(/SameSite=Lax/);
    expect(devCookie).not.toMatch(/Secure/);
    const prodRes = await request(testApp({ allowDevAuth: false, isProduction: true }))
      .post("/v1/auth/platform/exchange")
      .send({ platform: "telegram", initData: signedTelegram(9999) });
    expect(prodRes.status).toBe(200);
    const prodCookie = cookies(prodRes);
    expect(prodCookie).toMatch(/SameSite=None/);
    expect(prodCookie).toMatch(/Secure/);
    expect(prodCookie).toMatch(/HttpOnly/);
  });
});
