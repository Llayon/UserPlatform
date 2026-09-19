/**
 * MAX Mini App initData server-side validation.
 * Docs: https://dev.max.ru/docs/webapps/bridge (verified 2026-09-19).
 *
 * VERIFIED DIFFERENCES vs Telegram (documented, not assumed):
 * 1. Same HMAC-SHA256("WebAppData", token) signature scheme over sorted
 *    key=value lines (ecosystem-attested: maxoxide, community MAX bots;
 *    exact byte layout to be re-verified with a live MAX bot token in Phase 2).
 * 2. Freshness: MAX recommends auth_date max age of 1 HOUR (dev.max.ru).
 * 3. Extra `ip` field may be present — treated as opaque, never identity.
 * 4. chat.type enum is DIALOG | CHAT | CHANNEL (Telegram uses different chat
 *    context fields: chat_type/chat_instance).
 * 5. start_param arrives via ?startapp= links, payload limited to 512 chars.
 * 6. Separate phone-check flow exists (HMAC over sorted authDate+phone+userId
 *    with the bot token as key DIRECTLY — different construction, NOT used here).
 * 7. Strict parsing: duplicate keys rejected, exactly one `hash` required.
 */
import {
  buildDataCheckString,
  computeInitDataHash,
  deriveWebAppSecret,
  hasDuplicateKeys,
  parseInitDataPairs,
  safeEqualHex,
} from "./initdata.js";

export interface MaxIdentity {
  provider: "max";
  providerUserId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  authDate: number;
  startParam?: string;
}

export type MaxValidationError =
  | "MALFORMED"
  | "DUPLICATE_KEYS"
  | "MISSING_HASH"
  | "INVALID_SIGNATURE"
  | "MISSING_AUTH_DATE"
  | "EXPIRED"
  | "FUTURE_SKEW"
  | "MISSING_USER"
  | "INVALID_USER";

export interface MaxValidatorOptions {
  /** Max age of auth_date in seconds. Default 3600 (MAX recommended 1 hour). */
  maxAgeSeconds?: number;
  /** Allowed future clock skew in seconds. Default 30. */
  futureToleranceSeconds?: number;
  /** Unix seconds override (tests only). Defaults to now. */
  nowSeconds?: number;
}

const MAX_CHAT_TYPES = new Set(["DIALOG", "CHAT", "CHANNEL"]);

export function validateMaxInitData(
  raw: string,
  botToken: string,
  opts: MaxValidatorOptions = {},
): { ok: true; identity: MaxIdentity } | { ok: false; error: MaxValidationError } {
  const maxAge = opts.maxAgeSeconds ?? 3600;
  const futureTolerance = opts.futureToleranceSeconds ?? 30;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!raw || !botToken) return { ok: false, error: "MALFORMED" };
  if (hasDuplicateKeys(raw)) return { ok: false, error: "DUPLICATE_KEYS" };

  const parsed = parseInitDataPairs(raw);
  if (!parsed || !parsed.hash || parsed.hashCount !== 1) {
    return { ok: false, error: !parsed || !parsed.hash ? "MISSING_HASH" : "MALFORMED" };
  }

  const checkString = buildDataCheckString(parsed.pairs);
  const expected = computeInitDataHash(checkString, deriveWebAppSecret(botToken));
  if (!safeEqualHex(parsed.hash, expected)) return { ok: false, error: "INVALID_SIGNATURE" };

  const fields = new Map(parsed.pairs);
  const authDateRaw = fields.get("auth_date");
  const authDate = authDateRaw !== undefined ? Number(authDateRaw) : NaN;
  if (!authDateRaw || !Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: "MISSING_AUTH_DATE" };
  }
  if (authDate > now + futureTolerance) return { ok: false, error: "FUTURE_SKEW" };
  if (now - authDate > maxAge) return { ok: false, error: "EXPIRED" };

  const userRaw = fields.get("user");
  if (!userRaw) return { ok: false, error: "MISSING_USER" };
  let user: unknown;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: "INVALID_USER" };
  }
  if (typeof user !== "object" || user === null) return { ok: false, error: "INVALID_USER" };
  const u = user as Record<string, unknown>;
  if (typeof u.id !== "number" || !Number.isInteger(u.id) || u.id <= 0) {
    return { ok: false, error: "INVALID_USER" };
  }

  // chat is opaque context; validate shape lightly, never identity.
  const chatRaw = fields.get("chat");
  if (chatRaw) {
    try {
      const chat = JSON.parse(chatRaw) as Record<string, unknown>;
      if (typeof chat.type === "string" && !MAX_CHAT_TYPES.has(chat.type)) {
        return { ok: false, error: "MALFORMED" };
      }
    } catch {
      return { ok: false, error: "MALFORMED" };
    }
  }

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v.slice(0, 256) : undefined;
  // NOTE: same sanitization boundary as Telegram — exchange MUST run
  // parseStartParam() before storing start_param. Telemetry only.
  const startParam = str(fields.get("start_param"));

  return {
    ok: true,
    identity: {
      provider: "max",
      providerUserId: String(u.id),
      username: str(u.username),
      firstName: str(u.first_name),
      lastName: str(u.last_name),
      languageCode: str(u.language_code),
      authDate,
      ...(startParam ? { startParam } : {}),
    },
  };
}
