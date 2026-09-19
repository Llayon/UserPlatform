/**
 * Shared Mini App initData validation primitives.
 * Both Telegram and MAX sign launch params with:
 *   secret   = HMAC-SHA256(key = "WebAppData", msg = bot token)
 *   expected = HMAC-SHA256(secret, data_check_string) as hex
 * where data_check_string = sorted `key=<decoded value>` lines joined with \n
 * (the `hash` pair excluded). Comparison must be constant-time.
 * Sources: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * (Bot API 10.1, verified 2026-09-19), https://dev.max.ru/docs/webapps/bridge,
 * ecosystem attestations (maxoxide validation steps, community MAX bots).
 */
import crypto from "node:crypto";

export interface ParsedInitData {
  /** All decoded pairs except `hash`, plus duplicate-key info. */
  pairs: Array<[string, string]>;
  hash: string;
  hashCount: number;
}

export function parseInitDataPairs(raw: string): ParsedInitData | null {
  if (!raw || raw.length > 8192) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const pairs: Array<[string, string]> = [];
  let hash = "";
  let hashCount = 0;
  for (const [key, value] of params) {
    if (!key) return null;
    if (key === "hash") {
      hashCount += 1;
      hash = value;
      continue;
    }
    pairs.push([key, value]);
  }
  return { pairs, hash, hashCount };
}

/** True when any key appears more than once (ambiguous signing input). */
export function hasDuplicateKeys(raw: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return true;
  }
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function buildDataCheckString(pairs: Array<[string, string]>): string {
  return pairs
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
}

export function deriveWebAppSecret(botToken: string): Buffer {
  return crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
}

export function computeInitDataHash(dataCheckString: string, secret: Buffer): string {
  return crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/** Constant-time hex comparison. Returns false on malformed hex. */
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  let aBuf: Buffer;
  let bBuf: Buffer;
  try {
    aBuf = Buffer.from(a, "hex");
    bBuf = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
