import { describe, it, expect } from "vitest";
import { loadConfig, sessionCookieFlags } from "../src/config.js";

describe("loadConfig", () => {
  it("treats Vercel preview as production posture (no mock, strict cookies)", () => {
    const cfg = loadConfig({ NODE_ENV: "development", VERCEL_ENV: "preview" } as NodeJS.ProcessEnv);
    expect(cfg.isProduction).toBe(true);
    expect(cfg.allowDevAuth).toBe(false);
    expect(sessionCookieFlags(true)).toMatchObject({ secure: true, sameSite: "none" });
  });

  it("local development keeps lax cookies and gated dev auth", () => {
    const cfg = loadConfig({ NODE_ENV: "development", PLATFORM_ALLOW_DEV_AUTH: "true" } as NodeJS.ProcessEnv);
    expect(cfg.isProduction).toBe(false);
    expect(cfg.allowDevAuth).toBe(true);
    expect(sessionCookieFlags(false)).toMatchObject({ secure: false, sameSite: "lax" });
  });

  it("dev flag alone never enables mock auth in production", () => {
    const cfg = loadConfig({ NODE_ENV: "production", PLATFORM_ALLOW_DEV_AUTH: "true" } as NodeJS.ProcessEnv);
    expect(cfg.allowDevAuth).toBe(false);
  });

  it("parses numeric knobs with safe defaults", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).welcomeCredits).toBe(10);
    expect(loadConfig({ WELCOME_BONUS_CREDITS: "25" } as NodeJS.ProcessEnv).welcomeCredits).toBe(25);
    expect(loadConfig({ WELCOME_BONUS_CREDITS: "junk" } as NodeJS.ProcessEnv).welcomeCredits).toBe(10);
  });
});
