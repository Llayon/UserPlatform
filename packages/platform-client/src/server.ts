/**
 * Server-only Platform client (backend bridge integration path).
 *
 * Import ONLY from server code:
 *   import { createServerPlatformClient } from "@user-platform/platform-client/server";
 *
 * The browser `PlatformClient` never touches service credentials beyond an
 * injected callback and never calls the service exchange. This module is the
 * single sanctioned path for Holodilnik-style backends:
 *
 *   const platform = createServerPlatformClient({
 *     baseUrl,
 *     getServiceToken: () => process.env.USER_PLATFORM_SERVICE_TOKEN,
 *   });
 *   const ex = await platform.serviceAuth.exchangePlatform({ platform: "telegram", initData });
 *   // ex.session.token lives in server memory only → set your own HttpOnly cookie.
 *
 * This package never reads env itself; the caller injects getServiceToken().
 */
import type {
  Balance,
  CreditMutationResponse,
  MeResponse,
  ServicePlatformExchangeResult,
  UsageEntry,
} from "@user-platform/contracts";
import { PlatformApiError, ServiceTokenRequiredError } from "./client.js";

export interface ServerPlatformClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getServiceToken: () => string | undefined;
}

export interface ServerUsagePage {
  usage: UsageEntry[];
}

export class ServerPlatformClient {
  private appSessionToken: string | undefined;

  constructor(private readonly opts: ServerPlatformClientOptions) {}

  /** Forward the app-scoped session obtained from serviceAuth.exchangePlatform. */
  setAppSessionToken(token: string | undefined): void {
    this.appSessionToken = token;
  }

  private serviceToken(): string {
    const token = this.opts.getServiceToken?.();
    if (!token) throw new ServiceTokenRequiredError();
    return token;
  }

  private async request<T>(path: string, init?: RequestInit, withSession = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers["Authorization"] = `Bearer ${this.serviceToken()}`;
    if (withSession && this.appSessionToken) {
      headers["X-Platform-Session"] = this.appSessionToken;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
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

  serviceAuth = {
    exchangePlatform: (input: {
      platform: "telegram" | "max";
      initData: string;
      startParam?: string;
    }) =>
      this.request<ServicePlatformExchangeResult>("/v1/service/auth/platform-exchange", {
        method: "POST",
        body: JSON.stringify(input),
      }),
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

  me = {
    get: () => this.request<MeResponse>("/v1/me", { method: "GET" }, true),
    balance: () => this.request<Balance>("/v1/me/balance", { method: "GET" }, true),
    usage: (limit = 50) =>
      this.request<ServerUsagePage>(`/v1/me/usage?limit=${limit}`, { method: "GET" }, true),
  };
}

export function createServerPlatformClient(
  opts: ServerPlatformClientOptions,
): ServerPlatformClient {
  if (!opts.getServiceToken) throw new ServiceTokenRequiredError();
  return new ServerPlatformClient(opts);
}
