/**
 * @user-platform/contracts — shared schemas and types.
 * Single source of truth for Platform API shapes. Consumed by
 * apps/api, apps/account (via platform-client later) and future apps.
 * No Supabase/Express dependencies here — pure Zod + types.
 */
import { z } from "zod";

// ---------- identity ----------

export const platformSchema = z.enum(["telegram", "max", "web"]);
export type Platform = z.infer<typeof platformSchema>;

export const uuidSchema = z.uuid();

export const platformUserSchema = z.object({
  id: uuidSchema,
  status: z.enum(["active", "suspended"]),
  createdAt: z.string(),
});
export type PlatformUser = z.infer<typeof platformUserSchema>;

export const platformSessionSchema = z.object({
  userId: uuidSchema,
  expiresAt: z.string(),
});
export type PlatformSession = z.infer<typeof platformSessionSchema>;

// ---------- exchange ----------

export const exchangeRequestSchema = z.object({
  platform: z.enum(["telegram", "max"]),
  initData: z.string().min(1).max(8192),
  // Raw transport bound (matches signed payload allowance). The exchange
  // boundary must still run parseStartParam() — only sanitized values persist.
  startParam: z.string().max(512).optional(),
});
export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>;

export const exchangeResultSchema = z.object({
  user: platformUserSchema,
  isNewUser: z.boolean(),
  balance: z.number().int(),
  sessionExpiresAt: z.string(),
});
export type ExchangeResult = z.infer<typeof exchangeResultSchema>;

// ---------- registry ----------

export const appDescriptorSchema = z.object({
  id: uuidSchema,
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  status: z.enum(["active", "coming_soon", "disabled"]),
});
export type AppDescriptor = z.infer<typeof appDescriptorSchema>;

export const operationDescriptorSchema = z.object({
  id: uuidSchema,
  appSlug: z.string().min(1).max(64),
  operationKey: z.string().min(1).max(128),
  creditCost: z.number().int().min(0),
  enabled: z.boolean(),
});
export type OperationDescriptor = z.infer<typeof operationDescriptorSchema>;

// ---------- credits ----------

export const balanceSchema = z.object({
  available: z.number().int().min(0),
  reserved: z.number().int().min(0),
});
export type Balance = z.infer<typeof balanceSchema>;

export const reserveRequestSchema = z.object({
  operation: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, "must be app.operation"),
  // Idempotency key: opaque but charset-restricted so it is safe as a DB
  // unique key, log field and HTTP header value. No newlines/control chars.
  requestId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_:\-.]{8,128}$/, "unsafe requestId charset"),
});
export type CreditReserveRequest = z.infer<typeof reserveRequestSchema>;

export const reservationSchema = z.object({
  reservationId: uuidSchema,
  requestId: z.string(),
  operation: z.string(),
  amount: z.number().int().min(0),
  status: z.enum(["reserved", "committed", "released"]),
  balance: balanceSchema,
});
export type Reservation = z.infer<typeof reservationSchema>;

export const creditCommitRequestSchema = z.object({
  reservationId: uuidSchema,
});
export type CreditCommitRequest = z.infer<typeof creditCommitRequestSchema>;

export const creditReleaseRequestSchema = z.object({
  reservationId: uuidSchema,
});
export type CreditReleaseRequest = z.infer<typeof creditReleaseRequestSchema>;

// NOTE: no userId field exists on any credit request by design — the acting
// user is bound server-side from the session (§24). A service cannot name an
// arbitrary user, so there is nothing to tamper with (IDOR-proof by shape).

export const creditMutationResponseSchema = z.object({
  reservation: reservationSchema,
  reused: z.boolean(),
});
export type CreditMutationResponse = z.infer<typeof creditMutationResponseSchema>;

// ---------- usage ----------

export const usageEntrySchema = z.object({
  id: uuidSchema,
  appSlug: z.string(),
  operation: z.string(),
  requestId: z.string(),
  status: z.enum(["reserved", "committed", "released", "failed"]),
  createdAt: z.string(),
});
export type UsageEntry = z.infer<typeof usageEntrySchema>;

// ---------- me ----------

export const meProfileSchema = z.object({
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  locale: z.string().nullable(),
});
export type MeProfile = z.infer<typeof meProfileSchema>;

export const meResponseSchema = z.object({
  user: platformUserSchema,
  profile: meProfileSchema,
  balance: balanceSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// ---------- errors ----------

export const errorCodeSchema = z.enum([
  "INVALID_PLATFORM_DATA",
  "PLATFORM_DATA_EXPIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_PAYLOAD",
  "INSUFFICIENT_CREDITS",
  "RESERVATION_CONFLICT",
  "DUPLICATE_REQUEST",
  "RATE_LIMIT_UNAVAILABLE",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  code: errorCodeSchema,
});
export type ApiError = z.infer<typeof apiErrorSchema>;
