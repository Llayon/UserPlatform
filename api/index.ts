/**
 * Vercel API entrypoint (Holodilnik-proven pattern, read-only reference).
 *
 * Vercel Functions under `api/` are automatically routed to `/api/*`, and
 * vercel.json rewrites `/v1/*` + `/health` here with the prefix stripped.
 * This file mounts the injected Express app under BOTH prefixes so the
 * function answers regardless of which path form Vercel delivers.
 *
 * Pooling: one module-scope pg Pool (max 3, pooler URL required) shared by
 * warm invocations. Missing DATABASE_URL fails closed at boot (loud 500s,
 * never an open endpoint).
 */
import express from "express";
import { createPgDb, createRepos } from "@user-platform/db";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";

export function buildVercelApp(env: NodeJS.ProcessEnv = process.env): express.Express {
  const config = loadConfig(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Platform API (fail-closed, refusing to boot open)");
  }
  const inner = createApp({
    config,
    db: createPgDb(databaseUrl, { maxConnections: 3 }),
    repos: createRepos(),
  });
  const app = express();
  app.use("/api", inner);
  app.use("/", inner);
  return app;
}

const app = buildVercelApp();

export default app;
