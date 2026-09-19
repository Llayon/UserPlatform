import { describe, it, expect } from "vitest";
import request from "supertest";
import { createMemoryRepos, createMemoryStore } from "@user-platform/db";
import { createApp } from "../src/app.js";
import type { Db } from "@user-platform/db";

const noopDb: Db = {
  query: async () => ({ rows: [], rowCount: 0 }),
  withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
  close: async () => {},
};

function testApp() {
  return createApp({
    config: {
      port: 3002,
      isProduction: false,
      telegramBotToken: "",
      maxBotToken: "",
      welcomeCredits: 10,
      sessionTtlSeconds: 3600,
      allowDevAuth: true,
      sessionCookieName: "up_session",
      serviceToken: "",
      serviceTokenPrevious: "",
    },
    db: noopDb,
    repos: createMemoryRepos(createMemoryStore()),
  });
}

describe("api skeleton", () => {
  it("GET /health returns liveness", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("unknown routes return JSON 404, not HTML", async () => {
    const res = await request(testApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
