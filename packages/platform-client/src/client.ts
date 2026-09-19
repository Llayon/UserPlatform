/**
 * Reusable typed client for the User Platform API.
 *
 * Future apps (Holodilnik, Wardrobe, …) consume this instead of raw HTTP.
 *
 * Credential separation (critical):
 * - USER session: browser relies on the HttpOnly cookie automatically
 *   (credentials: "include"); server-side callers forward the incoming user
 *   token explicitly via setSessionToken() (X-Platform-Session header).
 * - SERVICE token: ONLY via the getServiceToken callback injected by
 *   server-side code. This package never reads env, never stores the token,
 *   and throws client-side if a service call is attempted without one — so
 *   the token cannot end up in a browser bundle by accident.
 */
import type {
  Balance,
  CreditMutationResponse,
  ExchangeResult,
  MeResponse,
  UsageEntry,
} from "@user-platform/contracts";

export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
  }
}

export class ServiceTokenRequiredError extends Error {
  constructor() {
    super("Service token required: credit calls are server-side only. Provide getServiceToken.");
    this.name = "ServiceTokenRequiredError";
  }
}

export interface PlatformClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getServiceToken?: () => string | undefined;
}

export interface UsagePage {
  usage: UsageEntry[];
}

export class PlatformClient {
  private sessionToken: string | undefined;

  constructor(private readonly opts: PlatformClientOptions) {}

  /** Server-side pattern: forward the incoming request's user session. */
  setSessionToken(token: string | undefined): void {
    this.sessionToken = token;
  }

  private async request<T>(path: string, init?: RequestInit, needsService = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.sessionToken) headers["X-Platform-Session"] = this.sessionToken;
    if (needsService) {
      const token = this.opts.getServiceToken?.();
      if (!token) throw new ServiceTokenRequiredError();
      headers["Authorization"] = `Bearer ${token}`;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      credentials: "include",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) {
      throw new PlatformApiError(
        res.status,
        json.code ?? "UNKNOWN",
        json.error ?? "Request failed",
      );
    }
    return json as T;
  }

  auth = {
    exchangePlatform: (input: {
      platform: "telegram" | "max";
      initData: string;
      startParam?: string;
    }) =>
      this.request<ExchangeResult>("/v1/auth/platform/exchange", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    exchangeDev: (persona: string) =>
      this.request<ExchangeResult>("/v1/auth/dev/exchange", {
        method: "POST",
        body: JSON.stringify({ persona }),
      }),
    logout: () => this.request<void>("/v1/auth/session", { method: "DELETE" }),
  };

  me = {
    get: () => this.request<MeResponse>("/v1/me"),
    balance: () => this.request<Balance>("/v1/me/balance"),
    usage: (limit = 50) => this.request<UsagePage>(`/v1/me/usage?limit=${limit}`),
  };

  credits = {
    reserve: (input: { operation: string; requestId: string }) =>
      this.request<CreditMutationResponse>(
        "/v1/credits/reserve",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    commit: (input: { reservationId: string }) =>
      this.request<CreditMutationResponse>(
        "/v1/credits/commit",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    release: (input: { reservationId: string }) =>
      this.request<CreditMutationResponse>(
        "/v1/credits/release",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
  };
}

export function createPlatformClient(opts: PlatformClientOptions): PlatformClient {
  return new PlatformClient(opts);
}
