/**
 * Per-application service credentials (Gauntlet 1).
 *
 * Token format: `ups_<keyId>_<secret>` (hex-only segments, so "_" is an
 * unambiguous separator — base64url was rejected because its alphabet
 * contains "_" itself, which broke parsing).
 * - keyId: 24 hex chars (12 random bytes = 96 bits, public lookup key).
 * - secret: 64 hex chars (32 random bytes = 256 bits entropy).
 * - DB stores SHA-256(secret) only; keyId is the indexed lookup key.
 * - Comparison is timingSafeEqual over SHA-256 digests (no length leak).
 *
 * Raw secrets appear ONLY in the one-time CLI creation output. Never log,
 * persist, or return them elsewhere.
 */
import crypto from "node:crypto";

export const SERVICE_TOKEN_PREFIX = "ups";
export const SERVICE_KEY_ID_BYTES = 12;
export const SERVICE_SECRET_BYTES = 32;

const KEY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_RE = /^[0-9a-f]+$/;

export interface GeneratedServiceToken {
  token: string;
  keyId: string;
  secret: string;
}

export function generateServiceToken(): GeneratedServiceToken {
  const keyId = crypto.randomBytes(SERVICE_KEY_ID_BYTES).toString("hex");
  const secret = crypto.randomBytes(SERVICE_SECRET_BYTES).toString("hex");
  return { token: `${SERVICE_TOKEN_PREFIX}_${keyId}_${secret}`, keyId, secret };
}

export function parseServiceToken(presented: string): { keyId: string; secret: string } | null {
  if (typeof presented !== "string" || presented.length > 256 || presented.length < 16) {
    return null;
  }
  const parts = presented.split("_");
  // Hex segments never contain "_", so exactly 3 parts are expected.
  if (parts.length !== 3) return null;
  const [prefix, keyId, secret] = parts;
  if (prefix !== SERVICE_TOKEN_PREFIX) return null;
  if (!KEY_ID_RE.test(keyId) || !HEX_RE.test(keyId)) return null;
  if (secret.length < 32 || secret.length > 128 || !HEX_RE.test(secret)) {
    return null;
  }
  return { keyId, secret };
}

export function hashServiceSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function sha256BufferHex(hexDigest: string): Buffer {
  return Buffer.from(hexDigest, "hex");
}

/** Constant-time secret check against the stored hash (hex). */
export function verifyServiceSecret(secret: string, storedHashHex: string): boolean {
  if (!secret || !storedHashHex) return false;
  try {
    const a = crypto.createHash("sha256").update(secret, "utf8").digest();
    const b = Buffer.from(storedHashHex, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isValidKeyId(keyId: string): boolean {
  return KEY_ID_RE.test(keyId);
}

export { sha256BufferHex };
