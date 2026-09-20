/**
 * Request authentication helpers (shared by user and service routes).
 *
 * Two independent credentials, never mixed:
 * - USER: session token from `up_session` cookie or `X-Platform-Session`
 *   header → server-side session row → active user + session scope. The
 *   userId used by every downstream call comes ONLY from here — request
 *   bodies contain no userId field by contract, so IDOR-by-parameter is
 *   structurally impossible. App identity NEVER comes from the session
 *   alone on service routes; it is cross-checked against the service
 *   credential (SERVICE APP == SESSION APP).
 * - SERVICE: `Authorization: Bearer ups_<keyId>_<secret>` looked up in
 *   `service_credentials` (hash-only storage, constant-time verify).
 *   Identity comes ONLY from credential→app mapping; callers never declare
 *   "I am fridge" via header/body.
 */
import {
  hashSessionToken,
  isSessionExpired,
  parseServiceToken,
  verifyServiceSecret,
} from "@user-platform/auth-core";
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
  sessionId: string;
  sessionType: "account" | "app";
  /** NULL for account sessions; app id for app sessions. */
  appId: string | null;
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
  return {
    userId: user.id,
    sessionId: session.id,
    sessionType: session.sessionType,
    appId: session.appId,
  };
}

export interface ServicePrincipal {
  credentialId: string;
  keyId: string;
  appId: string;
  appSlug: string;
}

/**
 * DB-backed service authentication (server-to-server only; never the browser).
 * Errors intentionally do not reveal whether a keyId exists (all failures
 * are 401 except disabled-app which is 403 per the error model).
 */
export async function resolveServicePrincipal(
  deps: { db: Db; repos: Repos },
  authorization: string | undefined,
): Promise<ServicePrincipal> {
  const presented =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
  if (!presented) {
    throw new HttpError(401, "UNAUTHORIZED", "Missing service credentials");
  }
  const parsed = parseServiceToken(presented);
  if (!parsed) {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
  }
  const credential = await deps.repos.serviceCredentials.findByKeyId(deps.db, parsed.keyId);
  // Do not distinguish unknown-key from wrong-secret (enumeration resistance).
  if (!credential || !verifyServiceSecret(parsed.secret, credential.secretHash)) {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
  }
  if (credential.status !== "active") {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
  }
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
  }
  const app = await deps.repos.registry.getAppById(deps.db, credential.appId);
  if (!app) {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid service credentials");
  }
  if (app.status === "disabled") {
    throw new HttpError(403, "FORBIDDEN", "Application disabled");
  }
  // Audit metadata only (keyId/appId are non-secret). Best-effort: auth must
  // not fail when the metadata write fails.
  try {
    await deps.repos.serviceCredentials.touchLastUsed(deps.db, credential.id);
  } catch {
    // Intentionally ignored — see above.
  }
  return {
    credentialId: credential.id,
    keyId: credential.keyId,
    appId: app.id,
    appSlug: app.slug,
  };
}
