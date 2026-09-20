import { Router } from "express";
import {
  exchangeRequestSchema,
  servicePlatformExchangeResultSchema,
} from "@user-platform/contracts";
import type { Db, Repos } from "@user-platform/db";
import type { ApiConfig } from "../config.js";
import { HttpError, resolveServicePrincipal } from "../auth.js";
import { getDevPersona } from "../devPersonas.js";
import {
  ExchangeError,
  exchangeIdentity,
  validatePlatformIdentity,
  type ExchangeIdentity,
} from "../services/exchange.js";

export interface ServiceRouteDeps {
  config: ApiConfig;
  db: Db;
  repos: Repos;
}

/**
 * Server-to-server platform exchange (backend bridge).
 * Auth: service credential ONLY. No cookies set, no browser surface.
 * Returns a raw opaque APP session to the trusted backend; the DB keeps
 * the hash only. Raw initData is validated then discarded (never logged
 * or persisted beyond normalized identity/acquisition fields).
 */
export function createServiceRouter(deps: ServiceRouteDeps): Router {
  const router = Router();
  const { config, db, repos } = deps;

  router.post("/auth/platform-exchange", async (req, res) => {
    try {
      const service = await resolveServicePrincipal(deps, req.headers.authorization);
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
        { explicitStartParam: parsed.data.startParam, appId: service.appId },
      );
      const payload = servicePlatformExchangeResultSchema.safeParse({
        user: {
          id: outcome.userId,
          status: outcome.userStatus,
          createdAt: outcome.userCreatedAt,
        },
        isNewUser: outcome.isNewUser,
        balance: outcome.availableBalance,
        app: { id: service.appId, slug: service.appSlug },
        session: { token: outcome.sessionToken, expiresAt: outcome.sessionExpiresAt },
      });
      if (!payload.success) {
        return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
      }
      // Intentionally no Set-Cookie: the backend stores this token itself.
      return res.json(payload.data);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      if (err instanceof ExchangeError) {
        return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
      }
      throw err;
    }
  });

  // Development-only service exchange (persona → APP session). Production 404.
  // Lets tests and local app backends exercise the bridge without real signatures.
  router.post("/auth/dev/exchange", async (req, res) => {
    try {
      const service = await resolveServicePrincipal(deps, req.headers.authorization);
      if (!deps.config.allowDevAuth) {
        return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      }
      const persona = getDevPersona(String(req.body?.persona ?? ""));
      if (!persona) {
        return res.status(400).json({ error: "Unknown persona", code: "INVALID_PAYLOAD" });
      }
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
        { appId: service.appId },
      );
      const payload = servicePlatformExchangeResultSchema.safeParse({
        user: {
          id: outcome.userId,
          status: outcome.userStatus,
          createdAt: outcome.userCreatedAt,
        },
        isNewUser: outcome.isNewUser,
        balance: outcome.availableBalance,
        app: { id: service.appId, slug: service.appSlug },
        session: { token: outcome.sessionToken, expiresAt: outcome.sessionExpiresAt },
      });
      if (!payload.success) {
        return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
      }
      return res.json(payload.data);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      return res.status(500).json({ error: "Exchange failed", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
