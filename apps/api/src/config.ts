/**
 * API configuration — read once at boot, passed explicitly (no globals).
 * Secrets stay server-side; only VITE_PLATFORM_API_URL is public-safe.
 *
 * Service authority is DB-backed per-app credentials (service_credentials);
 * there is no global PLATFORM_SERVICE_TOKEN. Removed in Gauntlet 1: any
 * legacy env value is ignored (no hidden global path).
 */
export interface ApiConfig {
  port: number;
  isProduction: boolean;
  telegramBotToken: string;
  maxBotToken: string;
  welcomeCredits: number;
  sessionTtlSeconds: number;
  /** Dev mock exchange allowed only when explicitly enabled AND not production. */
  allowDevAuth: boolean;
  sessionCookieName: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Vercel preview deployments must share production's security posture:
  // mock auth stays off and cookies stay strict even when NODE_ENV slips.
  const vercelEnv = env.VERCEL_ENV;
  const isProduction =
    env.NODE_ENV === "production" || vercelEnv === "production" || vercelEnv === "preview";
  return {
    port: parsePositiveInt(env.PORT, 3002),
    isProduction,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    maxBotToken: env.MAX_BOT_TOKEN ?? "",
    welcomeCredits: parsePositiveInt(env.WELCOME_BONUS_CREDITS, 10),
    sessionTtlSeconds: parsePositiveInt(env.SESSION_TTL_SECONDS, 30 * 24 * 3600),
    allowDevAuth: env.PLATFORM_ALLOW_DEV_AUTH === "true" && !isProduction,
    sessionCookieName: "up_session",
  };
}

/** Cookie attributes for Mini App webview deployment (see app.ts notes). */
export function sessionCookieFlags(isProduction: boolean): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "none" | "lax";
} {
  return isProduction
    ? { httpOnly: true, secure: true, sameSite: "none" }
    : { httpOnly: true, secure: false, sameSite: "lax" };
}
