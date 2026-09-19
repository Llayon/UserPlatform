/**
 * Request authentication helpers (shared by user and service routes).
 *
 * Two independent credentials, never mixed:
 * - USER: session token from `up_session` cookie or `X-Platform-Session`
 *   header → server-side session row → active user. The userId used by every
 *   downstream call comes ONLY from here (§24) — request bodies contain no
 *   userId field by contract, so IDOR-by-parameter is structurally impossible.
 * - SERVICE: `Authorization: Bearer <token>` against PLATFORM_SERVICE_TOKEN
 *   (plus PREVIOUS during rotation grace). Compared as SHA-256 hashes in
 *   constant time so token length is not leaked either.
 */
import crypto from "node:crypto";
import { hashSessionToken, isSessionExpired } from "@user-platform/auth-core";
import type { Db, Repos } from "@user-platform/db";
import type { ErrorCode } from "@user-platform/contracts";
import type { ApiConfig } from "./config.js";

export const SESSION_HEADER = "x-platform-session";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
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

export function readSessionToken(
  headers: { cookie?: string; [SESSION_HEADER]?: string | string[] },
  cookieName: string,
): string | undefined {
  const fromHeader = headers[SESSION_HEADER];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const fromCookie = readCookie(headers.cookie, cookieName);
  return fromCookie ? decodeURIComponent(fromCookie) : undefined;
}

export interface SessionPrincipal {
  userId: string;
}

export async function resolveSessionUser(
  deps: { config: ApiConfig; db: Db; repos: Repos },
  headers: { cookie?: string; [SESSION_HEADER]?: string | string[] },
): Promise<SessionPrincipal> {
  const raw = readSessionToken(headers, deps.config.sessionCookieName);
  if (!raw) throw new HttpError(401, "UNAUTHORIZED", "Not authenticated");
  const session = await deps.repos.sessions.getByTokenHash(deps.db, hashSessionToken(raw));
  if (!session || isSessionExpired(Date.parse(session.expiresAt))) {
    throw new HttpError(401, "UNAUTHORIZED", "Session expired");
  }
  const user = await deps.repos.users.getById(deps.db, session.userId);
  if (!user || user.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", "Account unavailable");
  }
  return { userId: user.id };
}

function sha256Hex(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Service credential check (server-to-server only; never the browser). */
export function requireServiceToken(
  config: Pick<ApiConfig, "serviceToken" | "serviceTokenPrevious">,
  authorization: string | undefined,
): void {
  const presented =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
  if (!presented || !config.serviceToken) {
    // Fail closed when no service token is configured: credit endpoints
    // are unusable rather than open.
    throw new HttpError(401, "UNAUTHORIZED", "Missing service credentials");
  }
  const candidates = [config.serviceToken, config.serviceTokenPrevious].filter(
    (t): t is string => !!t,
  );
  const digest = sha256Hex(presented);
  const ok = candidates.some((c) => crypto.timingSafeEqual(digest, sha256Hex(c)));
  if (!ok) throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
}
