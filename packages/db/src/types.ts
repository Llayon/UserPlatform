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

export type SessionType = "account" | "app";

export interface DbSession {
  id: string;
  tokenHash: string;
  userId: string;
  sessionType: SessionType;
  /** NULL for account sessions, NOT NULL for app sessions (DB CHECK-enforced). */
  appId: string | null;
  createdAt: string;
  expiresAt: string;
}

export type ServiceCredentialStatus = "active" | "revoked";

export interface DbServiceCredential {
  id: string;
  appId: string;
  keyId: string;
  secretHash: string;
  label: string | null;
  status: ServiceCredentialStatus;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
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

export interface DbAcquisition {
  userId: string;
  provider: IdentityProvider;
  startParam: string;
  firstSeenAt: string;
}
