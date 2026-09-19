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
export declare function buildVercelApp(env?: NodeJS.ProcessEnv): express.Express;
declare const app: express.Express;
export default app;
//# sourceMappingURL=index.d.ts.map