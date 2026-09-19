/**
 * Telegram Mini App initData server-side validation.
 * Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * (verified 2026-09-19, Bot API 10.1). initDataUnsafe must NEVER be trusted —
 * only the raw initData string, validated here, yields an identity.
 */
import {
  buildDataCheckString,
  computeInitDataHash,
  deriveWebAppSecret,
  hasDuplicateKeys,
  parseInitDataPairs,
  safeEqualHex,
} from "./initdata.js";

export interface TelegramIdentity {
  provider: "telegram";
  providerUserId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  authDate: number;
  startParam?: string;
}

export type TelegramValidationError =
  | "MALFORMED"
  | "DUPLICATE_KEYS"
  | "MISSING_HASH"
  | "INVALID_SIGNATURE"
  | "MISSING_AUTH_DATE"
  | "EXPIRED"
  | "FUTURE_SKEW"
  | "MISSING_USER"
  | "INVALID_USER";

export interface TelegramValidatorOptions {
  /** Max age of auth_date in seconds. Default 3600. */
  maxAgeSeconds?: number;
  /** Allowed future clock skew in seconds. Default 60. */
  futureToleranceSeconds?: number;
  /** Unix seconds override (tests only). Defaults to now. */
  nowSeconds?: number;
}

export function validateTelegramInitData(
  raw: string,
  botToken: string,
  opts: TelegramValidatorOptions = {},
): { ok: true; identity: TelegramIdentity } | { ok: false; error: TelegramValidationError } {
  const maxAge = opts.maxAgeSeconds ?? 3600;
  const futureTolerance = opts.futureToleranceSeconds ?? 60;
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

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v.slice(0, 256) : undefined;
  // NOTE: startParam here is authenticity-verified but NOT sanitized.
  // The exchange boundary (Phase 2) MUST pass it through parseStartParam()
  // before storage or analytics. Never route/execute on its value.
  const startParam = str(fields.get("start_param"));

  return {
    ok: true,
    identity: {
      provider: "telegram",
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
