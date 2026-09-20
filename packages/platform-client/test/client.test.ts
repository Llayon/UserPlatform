/**
 * platform-client wire tests: real HTTP against an ephemeral memory-backed
 * server. A tiny cookie jar emulates the browser (Node fetch has none);
 * the server-side pattern (manual session forwarding) is tested explicitly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMemoryRepos, createMemoryStore } from "@user-platform/db";
import { generateServiceToken, hashServiceSecret } from "@user-platform/auth-core";
import { createApp } from "@user-platform/api";
import { PlatformApiError, ServiceTokenRequiredError, createPlatformClient } from "../src/index.js";
import { createServerPlatformClient } from "../src/server.js";

function testConfig() {
  return {
    port: 0,
    isProduction: false,
    telegramBotToken: "t",
    maxBotToken: "m",
    welcomeCredits: 10,
    sessionTtlSeconds: 3600,
    allowDevAuth: true,
    sessionCookieName: "up_session",
  };
}

/** Minimal browser-like cookie jar for Node fetch. */
function jarredFetch(): { fetchImpl: typeof fetch; sessionCookie: () => string | undefined } {
  let cookie = "";
  return {
    sessionCookie: () => (cookie ? cookie.split(";")[0].split("=")[1] : undefined),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      const res = await fetch(url, { ...init, headers });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const token = setCookie.split(";")[0];
        cookie = token.endsWith("=") || token.split("=")[1] === "" ? "" : token;
      }
      return res;
    }) as typeof fetch,
  };
}

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let serviceToken = "";

beforeAll(async () => {
  const repos = createMemoryRepos(createMemoryStore());
  const exec = { query: async () => ({ rows: [], rowCount: 0 }) };
  const fridge = await repos.registry.getAppBySlug(exec, "fridge");
  if (!fridge) throw new Error("no fridge app");
  const gen = generateServiceToken();
  await repos.serviceCredentials.create(exec, {
    appId: fridge.id,
    keyId: gen.keyId,
    secretHash: hashServiceSecret(gen.secret),
    label: "client-test",
  });
  serviceToken = gen.token;
  const app = createApp({
    config: testConfig(),
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      withTransaction: (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
      close: async () => {},
    },
    repos,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

afterAll(async () => {
  await closeServer?.();
});

describe("PlatformClient (wire)", () => {
  it("dev exchange → me → balance → usage → logout", async () => {
    const jar = jarredFetch();
    const client = createPlatformClient({ baseUrl, fetchImpl: jar.fetchImpl });
    const ex = await client.auth.exchangeDev("telegram-user-1");
    expect(ex.isNewUser).toBe(true);
    expect(ex.balance).toBe(10);
    const me = await client.me.get();
    expect(me.user.id).toBe(ex.user.id);
    expect(await client.me.balance()).toEqual({ available: 10, reserved: 0 });
    expect((await client.me.usage()).usage).toEqual([]);
    await client.auth.logout();
    await expect(client.me.get()).rejects.toMatchObject({ status: 401 });
  });

  it("server pattern: service exchange → app session → spend", async () => {
    const server = createServerPlatformClient({
      baseUrl,
      getServiceToken: () => serviceToken,
    });
    // No real Telegram signatures in tests: use the dev bridge (same app-session shape).
    const dev = await fetch(`${baseUrl}/v1/service/auth/dev/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ persona: "telegram-user-2" }),
    });
    expect(dev.status).toBe(200);
    const devJson = (await dev.json()) as {
      session: { token: string };
      balance: number;
    };
    expect(devJson.balance).toBe(10);
    server.setAppSessionToken(devJson.session.token);
    const r = await server.credits.reserve({
      operation: "fridge.scan",
      requestId: "client-000001",
    });
    expect(r.reservation.balance).toEqual({ available: 9, reserved: 1 });
    const c = await server.credits.commit({ reservationId: r.reservation.reservationId });
    expect(c.reservation.status).toBe("committed");
    expect((await server.me.balance()).available).toBe(9);
  });

  it("credit calls without service token throw client-side (never hit network)", async () => {
    const client = createPlatformClient({ baseUrl });
    await expect(
      client.credits.reserve({ operation: "fridge.scan", requestId: "x-12345678" }),
    ).rejects.toBeInstanceOf(ServiceTokenRequiredError);
  });

  it("API errors surface as PlatformApiError with status+code", async () => {
    const jar = jarredFetch();
    const client = createPlatformClient({ baseUrl, fetchImpl: jar.fetchImpl });
    await expect(client.auth.exchangeDev("no-such-persona")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    });
    try {
      await client.auth.exchangeDev("no-such-persona");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformApiError);
    }
  });
});
