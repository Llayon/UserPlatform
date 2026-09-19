import { Router } from "express";
import { exchangeRequestSchema, exchangeResultSchema } from "@user-platform/contracts";
import { hashSessionToken } from "@user-platform/auth-core";
import type { Db, Repos } from "@user-platform/db";
import type { ApiConfig } from "../config.js";
import { getDevPersona, listDevPersonas } from "../devPersonas.js";
import {
  ExchangeError,
  exchangeIdentity,
  validatePlatformIdentity,
  type ExchangeIdentity,
} from "../services/exchange.js";
import { sessionCookieFlags } from "../config.js";

export interface AuthRouteDeps {
  config: ApiConfig;
  db: Db;
  repos: Repos;
}

function toPublicResult(outcome: {
  userId: string;
  userStatus: string;
  userCreatedAt: string;
  isNewUser: boolean;
  availableBalance: number;
  sessionExpiresAt: string;
}): Record<string, unknown> {
  const parsed = exchangeResultSchema.safeParse({
    user: { id: outcome.userId, status: outcome.userStatus, createdAt: outcome.userCreatedAt },
    isNewUser: outcome.isNewUser,
    balance: outcome.availableBalance,
    sessionExpiresAt: outcome.sessionExpiresAt,
  });
  // exchangeResultSchema is a contract guarantee: never leak internals on mismatch.
  if (!parsed.success) {
    throw new ExchangeError("INTERNAL_ERROR", "Exchange result failed contract validation");
  }
  return parsed.data;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = Router();
  const { config, db, repos } = deps;
  const flags = sessionCookieFlags(config.isProduction);

  const setSessionCookie = (res: import("express").Response, token: string, expiresAt: string) => {
    const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    const parts = [
      `${config.sessionCookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      `Max-Age=${maxAge}`,
      flags.httpOnly ? "HttpOnly" : "",
      flags.secure ? "Secure" : "",
      `SameSite=${flags.sameSite === "none" ? "None" : "Lax"}`,
    ].filter(Boolean);
    res.setHeader("Set-Cookie", parts.join("; "));
  };

  router.post("/platform/exchange", async (req, res) => {
    try {
      const parsed = exchangeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      let identity: ExchangeIdentity;
      try {
        identity = validatePlatformIdentity(
          { telegramBotToken: config.telegramBotToken, maxBotToken: config.maxBotToken },
          parsed.data.platform,
          parsed.data.initData,
        );
      } catch (err) {
        if (err instanceof ExchangeError) {
          const status = err.code === "PLATFORM_DATA_EXPIRED" ? 401 : 400;
          const code =
            err.code === "INTERNAL_ERROR"
              ? "INTERNAL_ERROR"
              : err.code === "PLATFORM_DATA_EXPIRED"
                ? "PLATFORM_DATA_EXPIRED"
                : "INVALID_PLATFORM_DATA";
          return res.status(status).json({ error: err.message, code });
        }
        throw err;
      }
      const outcome = await exchangeIdentity(
        {
          db,
          repos,
          telegramBotToken: config.telegramBotToken,
          maxBotToken: config.maxBotToken,
          welcomeCredits: config.welcomeCredits,
          sessionTtlSeconds: config.sessionTtlSeconds,
        },
        identity,
        { explicitStartParam: parsed.data.startParam },
      );
      setSessionCookie(res, outcome.sessionToken, outcome.sessionExpiresAt);
      return res.json(toPublicResult(outcome));
    } catch (err) {
      if (err instanceof ExchangeError) {
        return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
      }
      throw err;
    }
  });

  // Development-only mock exchange. Production returns 404 (not enumerable).
  router.post("/dev/exchange", async (req, res) => {
    if (!deps.config.allowDevAuth) {
      return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    }
    const persona = getDevPersona(String(req.body?.persona ?? ""));
    if (!persona) {
      return res.status(400).json({
        error: `Unknown persona. Available: ${listDevPersonas()
          .map((p) => p.name)
          .join(", ")}`,
        code: "INVALID_PAYLOAD",
      });
    }
    try {
      const outcome = await exchangeIdentity(
        {
          db,
          repos,
          telegramBotToken: "dev",
          maxBotToken: "dev",
          welcomeCredits: config.welcomeCredits,
          sessionTtlSeconds: config.sessionTtlSeconds,
        },
        {
          provider: persona.provider,
          providerUserId: persona.providerUserId,
          username: persona.username,
          firstName: persona.firstName,
          languageCode: persona.languageCode,
        },
      );
      setSessionCookie(res, outcome.sessionToken, outcome.sessionExpiresAt);
      return res.json(toPublicResult(outcome));
    } catch {
      return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
    }
  });

  router.delete("/session", async (req, res) => {
    try {
      // No cookie-parser dependency: parse the single session cookie manually.
      const raw = readCookie(req.headers.cookie, config.sessionCookieName);
      if (raw) {
        await repos.sessions.deleteByTokenHash(db, hashSessionToken(decodeURIComponent(raw)));
      }
      res.setHeader(
        "Set-Cookie",
        `${config.sessionCookieName}=; Path=/; Max-Age=0; HttpOnly${flags.secure ? "; Secure" : ""}; SameSite=${flags.sameSite === "none" ? "None" : "Lax"}`,
      );
      return res.status(204).end();
    } catch {
      return res.status(500).json({ error: "Logout failed", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}
