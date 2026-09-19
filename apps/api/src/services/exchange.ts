/**
 * Platform exchange service: validated platform identity → internal account.
 *
 * Flow (all writes in ONE transaction):
 *   find identity → exists: touch + load (no bonus)
 *                 → absent: create user + identity + profile + wallet,
 *                   credit welcome bonus (ledger, idempotent per user),
 *                   record acquisition, mint session
 *   Always mints a fresh session (one exchange = one session).
 *
 * Race safety: parallel first-logins collide on UNIQUE(provider,
 * provider_user_id); the loser catches DbConflictError, rolls back, and
 * re-runs ONCE as the returning-user path. The welcome ledger row is written
 * only inside the winning signup tx under idempotency key `welcome_bonus`,
 * so double bonuses are impossible (constraint, not application check).
 */
import {
  parseStartParam,
  validateMaxInitData,
  validateTelegramInitData,
  createSessionToken,
  hashSessionToken,
  sessionExpiresAt,
  type MaxIdentity,
  type TelegramIdentity,
} from "@user-platform/auth-core";
import {
  DbConflictError,
  type Db,
  type DbTx,
  type IdentityProvider,
  type Repos,
} from "@user-platform/db";

export const WELCOME_BONUS_CREDITS = 10;
export const WELCOME_BONUS_REASON = "welcome_bonus";
export const WELCOME_IDEMPOTENCY_KEY = "welcome_bonus";

export type ExchangeErrorCode =
  "INVALID_PLATFORM_DATA" | "PLATFORM_DATA_EXPIRED" | "INTERNAL_ERROR";

export class ExchangeError extends Error {
  readonly code: ExchangeErrorCode;
  constructor(code: ExchangeErrorCode, message: string) {
    super(message);
    this.name = "ExchangeError";
    this.code = code;
  }
}

export interface ExchangeDeps {
  db: Db;
  repos: Repos;
  telegramBotToken: string;
  maxBotToken: string;
  welcomeCredits?: number;
  sessionTtlSeconds?: number;
}

/** Validated identity fields shared by real and dev paths. */
export interface ExchangeIdentity {
  provider: IdentityProvider;
  providerUserId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  rawStartParam?: string;
}

export interface ExchangeOutcome {
  userId: string;
  userStatus: string;
  userCreatedAt: string;
  isNewUser: boolean;
  availableBalance: number;
  displayName: string;
  sessionToken: string;
  sessionExpiresAt: string;
}

function toExchangeIdentity(id: TelegramIdentity | MaxIdentity): ExchangeIdentity {
  return {
    provider: id.provider,
    providerUserId: id.providerUserId,
    username: id.username,
    firstName: id.firstName,
    lastName: id.lastName,
    languageCode: id.languageCode,
    rawStartParam: id.startParam,
  };
}

export function validatePlatformIdentity(
  deps: Pick<ExchangeDeps, "telegramBotToken" | "maxBotToken">,
  platform: "telegram" | "max",
  initData: string,
): ExchangeIdentity {
  const token = platform === "telegram" ? deps.telegramBotToken : deps.maxBotToken;
  if (!token) throw new ExchangeError("INVALID_PLATFORM_DATA", "Platform provider not configured");
  const res =
    platform === "telegram"
      ? validateTelegramInitData(initData, token)
      : validateMaxInitData(initData, token);
  if (!res.ok) {
    if (res.error === "EXPIRED" || res.error === "FUTURE_SKEW") {
      throw new ExchangeError("PLATFORM_DATA_EXPIRED", `Stale platform data: ${res.error}`);
    }
    throw new ExchangeError("INVALID_PLATFORM_DATA", `Invalid platform data: ${res.error}`);
  }
  return toExchangeIdentity(res.identity);
}

export function buildDisplayName(
  identity: Pick<ExchangeIdentity, "firstName" | "lastName" | "username">,
): string {
  const full = `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim();
  if (full) return full.slice(0, 128);
  if (identity.username) return identity.username.slice(0, 128);
  return "Гость";
}

export async function exchangeIdentity(
  deps: ExchangeDeps,
  identity: ExchangeIdentity,
  opts?: { explicitStartParam?: string; nowMs?: number },
): Promise<ExchangeOutcome> {
  const { db, repos } = deps;
  const welcomeCredits = deps.welcomeCredits ?? WELCOME_BONUS_CREDITS;
  const ttlSeconds = deps.sessionTtlSeconds ?? 30 * 24 * 3600;
  const nowMs = opts?.nowMs ?? Date.now();
  // Sanitization boundary: authenticity was proven by signature validation;
  // only the sanitized value persists, and it is telemetry-only.
  const startParam = parseStartParam(opts?.explicitStartParam ?? identity.rawStartParam).value;

  try {
    return await db.withTransaction((tx) =>
      signupOrLogin(tx, deps, repos, identity, { startParam, welcomeCredits, ttlSeconds, nowMs }),
    );
  } catch (err) {
    if (!(err instanceof DbConflictError)) throw err;
    // Lost a parallel-signup race: the winner committed. Re-run once as the
    // returning-user path (which grants no bonus by construction).
    return db.withTransaction((tx) =>
      loginExisting(tx, deps, repos, identity, { ttlSeconds, nowMs }),
    );
  }
}

async function signupOrLogin(
  tx: DbTx,
  deps: ExchangeDeps,
  repos: Repos,
  identity: ExchangeIdentity,
  ctx: { startParam: string; welcomeCredits: number; ttlSeconds: number; nowMs: number },
): Promise<ExchangeOutcome> {
  const existing = await repos.identities.findByProvider(
    tx,
    identity.provider,
    identity.providerUserId,
  );
  if (existing) {
    return loginExisting(tx, deps, repos, identity, {
      ttlSeconds: ctx.ttlSeconds,
      nowMs: ctx.nowMs,
    });
  }

  const user = await repos.users.create(tx, {});
  // May throw DbConflictError on a parallel-signup race → caller retries as login.
  await repos.identities.create(tx, {
    userId: user.id,
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    providerUsername: identity.username ?? null,
  });
  const displayName = buildDisplayName(identity);
  await repos.profiles.create(tx, {
    userId: user.id,
    displayName,
    avatarUrl: null,
    locale: identity.languageCode ?? null,
  });
  await repos.wallets.create(tx, user.id);
  const wallet = await repos.wallets.adjust(tx, user.id, { available: ctx.welcomeCredits });
  if (!wallet) throw new ExchangeError("INTERNAL_ERROR", "Wallet vanished mid-signup");
  // Idempotency key is per-user: even a retried tx cannot double-grant.
  await repos.ledger.append(tx, {
    userId: user.id,
    delta: ctx.welcomeCredits,
    balanceAfter: wallet.availableBalance,
    reason: WELCOME_BONUS_REASON,
    idempotencyKey: WELCOME_IDEMPOTENCY_KEY,
  });
  await repos.acquisitions.recordFirstSeen(tx, {
    userId: user.id,
    provider: identity.provider,
    startParam: ctx.startParam,
  });
  const session = await mintSession(tx, repos, user.id, ctx.ttlSeconds, ctx.nowMs);
  return {
    userId: user.id,
    userStatus: user.status,
    userCreatedAt: user.createdAt,
    isNewUser: true,
    availableBalance: wallet.availableBalance,
    displayName,
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
  };
}

async function loginExisting(
  tx: DbTx,
  _deps: ExchangeDeps,
  repos: Repos,
  identity: ExchangeIdentity,
  ctx: { ttlSeconds: number; nowMs: number },
): Promise<ExchangeOutcome> {
  const existing = await repos.identities.findByProvider(
    tx,
    identity.provider,
    identity.providerUserId,
  );
  if (!existing) throw new ExchangeError("INTERNAL_ERROR", "Identity vanished mid-exchange");
  await repos.identities.touchLastSeen(tx, existing.id, new Date(ctx.nowMs).toISOString());
  const user = await repos.users.getById(tx, existing.userId);
  if (!user) throw new ExchangeError("INTERNAL_ERROR", "User vanished mid-exchange");
  // Wallet is an invariant of signup (same tx). Absence means corruption:
  // fail closed rather than silently recreating (which could mask bugs).
  const wallet = await repos.wallets.getByUserId(tx, user.id);
  if (!wallet) throw new ExchangeError("INTERNAL_ERROR", "Wallet missing for existing user");
  const profile = await repos.profiles.getByUserId(tx, user.id);
  const session = await mintSession(tx, repos, user.id, ctx.ttlSeconds, ctx.nowMs);
  return {
    userId: user.id,
    userStatus: user.status,
    userCreatedAt: user.createdAt,
    isNewUser: false,
    availableBalance: wallet.availableBalance,
    displayName: profile?.displayName ?? buildDisplayName(identity),
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
  };
}

async function mintSession(
  tx: DbTx,
  repos: Repos,
  userId: string,
  ttlSeconds: number,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const token = createSessionToken();
  const expiresAt = new Date(sessionExpiresAt(nowMs, ttlSeconds)).toISOString();
  await repos.sessions.create(tx, { tokenHash: hashSessionToken(token), userId, expiresAt });
  return { token, expiresAt };
}
