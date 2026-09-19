/**
 * Host platform abstraction (§32).
 * Exactly ONE place in the codebase touches `window.Telegram` / `window.WebApp`.
 * Everything else consumes the normalized HostAdapter: no scattered globals.
 */
export type HostKind = "telegram" | "max" | "browser";
export type ColorScheme = "light" | "dark";

export interface HostUserPreview {
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
}

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface HostAdapter {
  readonly kind: HostKind;
  /** Raw signed launch params for server exchange (empty in browser dev). */
  readonly initDataRaw: string;
  /** Acquisition tag from the launch link (may be empty). */
  readonly startParam: string;
  /** UNTRUSTED preview for provisional UI only — never auth proof. */
  readonly userPreview: HostUserPreview | null;
  readonly colorScheme: ColorScheme;
  readonly safeArea: SafeAreaInsets;
  ready(): void;
  close(): void;
  showBackButton(onClick: () => void): void;
  hideBackButton(): void;
}

interface WindowWithHosts {
  Telegram?: { WebApp?: Record<string, unknown> };
  WebApp?: Record<string, unknown> & { TelegramWebApp?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseScheme(value: unknown): ColorScheme {
  return value === "dark" ? "dark" : "light";
}

class TelegramHost implements HostAdapter {
  readonly kind = "telegram" as const;
  constructor(
    readonly initDataRaw: string,
    readonly startParam: string,
    readonly userPreview: HostUserPreview | null,
    readonly colorScheme: ColorScheme,
    readonly safeArea: SafeAreaInsets,
    private readonly api: Record<string, unknown>,
  ) {}
  ready(): void {
    (this.api["ready"] as (() => void) | undefined)?.();
  }
  close(): void {
    (this.api["close"] as (() => void) | undefined)?.();
  }
  showBackButton(onClick: () => void): void {
    const back = asRecord(this.api["BackButton"]);
    (back?.["show"] as (() => void) | undefined)?.();
    (back?.["onClick"] as ((cb: () => void) => void) | undefined)?.(onClick);
  }
  hideBackButton(): void {
    const back = asRecord(this.api["BackButton"]);
    (back?.["hide"] as (() => void) | undefined)?.();
    (back?.["offClick"] as ((cb: () => void) => void) | undefined)?.(() => {});
  }
}

class MaxHost implements HostAdapter {
  readonly kind = "max" as const;
  constructor(
    readonly initDataRaw: string,
    readonly startParam: string,
    readonly userPreview: HostUserPreview | null,
    readonly colorScheme: ColorScheme,
    readonly safeArea: SafeAreaInsets,
    private readonly api: Record<string, unknown>,
  ) {}
  ready(): void {
    (this.api["ready"] as (() => void) | undefined)?.();
  }
  close(): void {
    (this.api["close"] as (() => void) | undefined)?.();
  }
  showBackButton(onClick: () => void): void {
    const back = asRecord(this.api["BackButton"]);
    (back?.["show"] as (() => void) | undefined)?.();
    (back?.["onClick"] as ((cb: () => void) => void) | undefined)?.(onClick);
  }
  hideBackButton(): void {
    const back = asRecord(this.api["BackButton"]);
    (back?.["hide"] as (() => void) | undefined)?.();
    (back?.["offClick"] as ((cb: () => void) => void) | undefined)?.(() => {});
  }
}

class BrowserHost implements HostAdapter {
  readonly kind = "browser" as const;
  readonly initDataRaw = "";
  readonly startParam = "";
  readonly userPreview: HostUserPreview | null = null;
  readonly colorScheme: ColorScheme =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  readonly safeArea: SafeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  ready(): void {}
  close(): void {
    window.close();
  }
  showBackButton(): void {}
  hideBackButton(): void {}
}

function readTelegram(w: WindowWithHosts): HostAdapter | null {
  const api = asRecord(w.Telegram?.WebApp);
  if (!api) return null;
  const unsafe = asRecord(api["initDataUnsafe"]);
  const user = asRecord(unsafe?.["user"]);
  const safeArea = asRecord(api["safeAreaInset"]) ?? {};
  return new TelegramHost(
    asString(api["initData"]),
    asString(unsafe?.["start_param"]),
    user
      ? {
          firstName: asString(user["first_name"]) || undefined,
          lastName: asString(user["last_name"]) || undefined,
          username: asString(user["username"]) || undefined,
          photoUrl: asString(user["photo_url"]) || undefined,
        }
      : null,
    parseScheme(api["colorScheme"]),
    {
      top: asNumber(safeArea["top"]),
      bottom: asNumber(safeArea["bottom"]),
      left: asNumber(safeArea["left"]),
      right: asNumber(safeArea["right"]),
    },
    api,
  );
}

function readMax(w: WindowWithHosts, telegramPresent: boolean): HostAdapter | null {
  // A bare window.WebApp without any Telegram markers belongs to MAX.
  // When Telegram globals exist (even partially), never misread as MAX.
  if (telegramPresent) return null;
  const api = asRecord(w.WebApp);
  if (!api) return null;
  const unsafe = asRecord(api["initDataUnsafe"]);
  const user = asRecord(unsafe?.["user"]);
  return new MaxHost(
    asString(api["initData"]),
    asString(unsafe?.["start_param"]),
    user
      ? {
          firstName: asString(user["first_name"]) || undefined,
          lastName: asString(user["last_name"]) || undefined,
          username: asString(user["username"]) || undefined,
          photoUrl: asString(user["photo_url"]) || undefined,
        }
      : null,
    parseScheme(api["colorScheme"] ?? api["theme"]),
    { top: 0, bottom: 0, left: 0, right: 0 },
    api,
  );
}

/**
 * Detect the host exactly once at startup. Order matters: Telegram first
 * (its bridge shape is documented), then MAX, then browser fallback.
 * Malformed globals never throw — worst case is the safe browser adapter.
 */
export function detectHost(global: unknown = globalThis): HostAdapter {
  try {
    const w = (global as { window?: WindowWithHosts }).window ?? (global as WindowWithHosts);
    const telegramPresent = !!asRecord(w.Telegram);
    return readTelegram(w) ?? readMax(w, telegramPresent) ?? new BrowserHost();
  } catch {
    return new BrowserHost();
  }
}
