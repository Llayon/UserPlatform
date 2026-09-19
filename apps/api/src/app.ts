import express from "express";
import type { Db, Repos } from "@user-platform/db";
import { loadConfig, type ApiConfig } from "./config.js";
import { createAuthRouter } from "./routes/auth.js";
import { createCreditsRouter } from "./routes/credits.js";
import { createMeRouter } from "./routes/me.js";

export interface AppDeps {
  config?: ApiConfig;
  db: Db;
  repos: Repos;
}

/**
 * Application factory — all dependencies injected (no globals), so HTTP
 * tests run against memory fakes and production wires real Postgres.
 *
 * Session cookie strategy (Mini App webviews are cross-site fetchers):
 * production → HttpOnly + Secure + SameSite=None (HTTPS only);
 * development → HttpOnly + SameSite=Lax (same-site localhost origins).
 * The user cookie guards READS (/me). Credit mutations are service-authed
 * (Phase 4) and never rely on this cookie — so no CSRF token layer is needed
 * for the current read-only surface. Any future user-mutating endpoint MUST
 * add CSRF protection before shipping.
 */
export function createApp(deps: AppDeps): express.Express {
  const config = deps.config ?? loadConfig();
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "user-platform-api", phase: 2 });
  });

  app.use("/v1/auth", createAuthRouter({ config, db: deps.db, repos: deps.repos }));
  app.use("/v1/me", createMeRouter({ config, db: deps.db, repos: deps.repos }));
  app.use("/v1/credits", createCreditsRouter({ config, db: deps.db, repos: deps.repos }));

  // JSON 404 (no HTML leaks, no stack traces).
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  });

  // Central error boundary — never leaks internals or secrets.
  // Logs the stack for production diagnosis (our errors carry codes only,
  // never tokens, initData or connection strings).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next;
      console.error(
        "[platform-api] unhandled:",
        err instanceof Error ? (err.stack ?? err.message) : String(err).slice(0, 500),
      );
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    },
  );

  return app;
}

export default createApp;
