import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildVercelApp } from "./index.js";

describe("Vercel adapter", () => {
  it("answers /health on both mount forms without a database", async () => {
    const app = buildVercelApp({ DATABASE_URL: "postgresql://localhost:1/x" } as NodeJS.ProcessEnv);
    for (const path of ["/health", "/api/health"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    }
  });

  it("answers stripped and prefixed API paths identically (rewrite parity)", async () => {
    const app = buildVercelApp({ DATABASE_URL: "postgresql://localhost:1/x" } as NodeJS.ProcessEnv);
    for (const path of ["/v1/me", "/api/v1/me"]) {
      const res = await request(app).get(path);
      // No cookie → 401 before any database touch (pool never connects).
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });

  it("dev exchange is unreachable in production posture", async () => {
    const app = buildVercelApp({
      DATABASE_URL: "postgresql://localhost:1/x",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    const res = await request(app).post("/v1/auth/dev/exchange").send({ persona: "telegram-user-1" });
    expect(res.status).toBe(404);
  });

  it("refuses to boot without DATABASE_URL (fail-closed, never open)", () => {
    expect(() => buildVercelApp({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});
