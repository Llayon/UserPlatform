import { Router } from "express";
import { meResponseSchema } from "@user-platform/contracts";
import { hashSessionToken, isSessionExpired } from "@user-platform/auth-core";
import type { Db, Repos } from "@user-platform/db";
import type { ApiConfig } from "../config.js";

export interface MeRouteDeps {
  config: ApiConfig;
  db: Db;
  repos: Repos;
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

export function createMeRouter(deps: MeRouteDeps): Router {
  const router = Router();
  const { config, db, repos } = deps;

  router.get("/", async (req, res) => {
    try {
      const raw = readCookie(req.headers.cookie, config.sessionCookieName);
      if (!raw) return res.status(401).json({ error: "Not authenticated", code: "UNAUTHORIZED" });
      const session = await repos.sessions.getByTokenHash(
        db,
        hashSessionToken(decodeURIComponent(raw)),
      );
      if (!session || isSessionExpired(Date.parse(session.expiresAt))) {
        return res.status(401).json({ error: "Session expired", code: "UNAUTHORIZED" });
      }
      const user = await repos.users.getById(db, session.userId);
      if (!user || user.status !== "active") {
        return res.status(403).json({ error: "Account unavailable", code: "FORBIDDEN" });
      }
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
      if (!parsed.success) {
        return res.status(500).json({ error: "Profile shape invalid", code: "INTERNAL_ERROR" });
      }
      return res.json(parsed.data);
    } catch {
      return res.status(500).json({ error: "Failed to load profile", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
