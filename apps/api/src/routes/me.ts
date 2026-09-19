import { Router } from "express";
import { meResponseSchema } from "@user-platform/contracts";
import type { Db, Repos } from "@user-platform/db";
import type { ApiConfig } from "../config.js";
import { HttpError, resolveSessionUser } from "../auth.js";

export interface MeRouteDeps {
  config: ApiConfig;
  db: Db;
  repos: Repos;
}

export function createMeRouter(deps: MeRouteDeps): Router {
  const router = Router();
  const { db, repos } = deps;

  const mePayload = async (userId: string) => {
    const user = await repos.users.getById(db, userId);
    // resolveSessionUser already proved active; absence here is corruption.
    if (!user) throw new HttpError(500, "INTERNAL_ERROR", "User vanished");
    const profile = await repos.profiles.getByUserId(db, user.id);
    const wallet = await repos.wallets.getByUserId(db, user.id);
    const parsed = meResponseSchema.safeParse({
      user: { id: user.id, status: user.status, createdAt: user.createdAt },
      profile: {
        displayName: profile?.displayName ?? "",
        avatarUrl: profile?.avatarUrl ?? null,
        locale: profile?.locale ?? null,
      },
      balance: {
        available: wallet?.availableBalance ?? 0,
        reserved: wallet?.reservedBalance ?? 0,
      },
    });
    if (!parsed.success) throw new HttpError(500, "INTERNAL_ERROR", "Profile shape invalid");
    return parsed.data;
  };

  router.get("/", async (req, res) => {
    try {
      const { userId } = await resolveSessionUser(deps, req.headers as Record<string, string>);
      return res.json(await mePayload(userId));
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Failed to load profile", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/balance", async (req, res) => {
    try {
      const { userId } = await resolveSessionUser(deps, req.headers as Record<string, string>);
      const wallet = await repos.wallets.getByUserId(db, userId);
      return res.json({
        available: wallet?.availableBalance ?? 0,
        reserved: wallet?.reservedBalance ?? 0,
      });
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Failed to load balance", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/usage", async (req, res) => {
    try {
      const { userId } = await resolveSessionUser(deps, req.headers as Record<string, string>);
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = Math.min(Math.max(parseInt(String(rawLimit ?? "50"), 10) || 50, 1), 200);
      const events = await repos.usage.listByUser(db, userId, limit);
      const apps = await repos.registry.listApps(db);
      const slugById = new Map(apps.map((a) => [a.id, a.slug]));
      return res.json({
        usage: events.map((e) => ({
          id: e.id,
          appSlug: (e.appId && slugById.get(e.appId)) || "unknown",
          operation: e.operation,
          requestId: e.requestId,
          status: e.status,
          createdAt: e.createdAt,
        })),
      });
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Failed to load usage", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
