/**
 * Platform session token helpers (pure part).
 * Sessions are opaque random tokens; only SHA-256 hashes are persisted.
 * Raw tokens travel via HttpOnly Secure cookies (set by apps/api); storage
 * and rotation live in Phase 2 (PostgreSQL sessions table).
 */
import crypto from "node:crypto";

export const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionExpiresAt(issuedAtMs: number, ttlSeconds = SESSION_TTL_SECONDS): number {
  return issuedAtMs + ttlSeconds * 1000;
}

export function isSessionExpired(expiresAtMs: number, nowMs = Date.now()): boolean {
  return nowMs >= expiresAtMs;
}
