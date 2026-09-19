import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("api skeleton", () => {
  it("GET /health returns liveness", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("unknown routes return JSON 404, not HTML", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
