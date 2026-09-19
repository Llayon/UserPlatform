/**
 * @user-platform/db — domain row types (camelCase).
 * Column mapping (snake_case ↔ camelCase) lives in postgres.ts only.
 * Timestamps are ISO strings; amounts are integer credits (never floats).
 */

export type UserStatus = "active" | "suspended";
export type IdentityProvider = "telegram" | "max" | "web" | "google" | "email" | "apple";
export type AppStatus = "active" | "coming_soon" | "disabled";
export type ReservationStatus = "reserved" | "committed" | "released";
export type UsageStatus = "reserved" | "committed" | "released" | "failed";

export interface DbUser {
  id: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DbIdentity {
  id: string;
  userId: string;
  provider: IdentityProvider;
  providerUserId: string;
  providerUsername: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface DbProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbSession {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface DbApp {
  id: string;
  slug: string;
  displayName: string;
  status: AppStatus;
  createdAt: string;
}

export interface DbOperation {
  id: string;
  appId: string;
  operationKey: string;
  creditCost: number;
  enabled: boolean;
  createdAt: string;
}

export interface DbWallet {
  userId: string;
  availableBalance: number;
  reservedBalance: number;
  version: number;
  updatedAt: string;
}

export interface DbReservation {
  id: string;
  userId: string;
  operationId: string | null;
  amount: number;
  status: ReservationStatus;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DbLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  appId: string | null;
  operationId: string | null;
  reservationId: string | null;
  reason: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DbUsageEvent {
  id: string;
  userId: string;
  appId: string | null;
  operation: string;
  requestId: string;
  status: UsageStatus;
  latencyMs: number | null;
  createdAt: string;
}

export interface DbEntitlement {
  userId: string;
  key: string;
  createdAt: string;
}
