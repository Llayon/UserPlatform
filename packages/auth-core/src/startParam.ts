/**
 * start_param sanitization + classification.
 * start_param arrives via Telegram ?startapp= / MAX ?startapp= links.
 * It is acquisition telemetry ONLY: never executed as route/code/URL.
 * Unknown values are stored verbatim (sanitized) for future analytics.
 */

const MAX_LENGTH = 64;
const SAFE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const KNOWN_EXACT = new Set(["fridge_scan", "wardrobe_add", "wardrobe_outfit", "interior_analyze"]);

const CAMPAIGN_PATTERN = /^campaign_[A-Za-z0-9_-]{1,32}$/;

export type StartParamKind = "known" | "campaign" | "generic" | "invalid";

export interface ParsedStartParam {
  kind: StartParamKind;
  /** Sanitized value (empty when invalid). */
  value: string;
}

export function parseStartParam(raw: unknown): ParsedStartParam {
  if (typeof raw !== "string") return { kind: "invalid", value: "" };
  // Reject overlong input outright: silent truncation could map two
  // different acquisition tags onto the same stored value.
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return { kind: "invalid", value: "" };
  if (!SAFE_PATTERN.test(value)) return { kind: "invalid", value: "" };
  if (KNOWN_EXACT.has(value)) return { kind: "known", value };
  if (CAMPAIGN_PATTERN.test(value)) return { kind: "campaign", value };
  return { kind: "generic", value };
}
