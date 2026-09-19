import { describe, it, expect } from "vitest";
import { validateTelegramInitData } from "../src/telegram.js";
import { signInitData, getTestToken, baseFields } from "./vectors.js";

const NOW = 1_700_000_000;

describe("validateTelegramInitData", () => {
  it("accepts valid signed data and extracts identity", () => {
    const raw = signInitData(baseFields(NOW));
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.provider).toBe("telegram");
    expect(res.identity.providerUserId).toBe("123");
    expect(res.identity.username).toBe("tester");
    expect(res.identity.authDate).toBe(NOW);
  });

  it("rejects tampered user payload", () => {
    const raw = signInitData(baseFields(NOW));
    const tampered = raw.replace("tester", "attacker");
    const res = validateTelegramInitData(tampered, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "INVALID_SIGNATURE" });
  });

  it("rejects wrong bot token", () => {
    const raw = signInitData(baseFields(NOW));
    const res = validateTelegramInitData(raw, "wrong-token", { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "INVALID_SIGNATURE" });
  });

  it("rejects missing hash", () => {
    const params = new URLSearchParams(baseFields(NOW));
    const res = validateTelegramInitData(params.toString(), getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "MISSING_HASH" });
  });

  it("rejects duplicate keys", () => {
    const raw = signInitData(baseFields(NOW)) + "&auth_date=999";
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "DUPLICATE_KEYS" });
  });

  it("rejects expired data", () => {
    const raw = signInitData(baseFields(NOW - 7200));
    const res = validateTelegramInitData(raw, getTestToken(), {
      nowSeconds: NOW,
      maxAgeSeconds: 3600,
    });
    expect(res).toEqual({ ok: false, error: "EXPIRED" });
  });

  it("rejects future auth_date beyond tolerance", () => {
    const raw = signInitData(baseFields(NOW + 600));
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "FUTURE_SKEW" });
  });

  it("rejects missing user", () => {
    const { user: _u, ...rest } = baseFields(NOW);
    void _u;
    const raw = signInitData(rest);
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "MISSING_USER" });
  });

  it("rejects malformed user JSON", () => {
    const raw = signInitData({ ...baseFields(NOW), user: "not-json{{{" });
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "INVALID_USER" });
  });

  it("rejects non-integer user id", () => {
    const raw = signInitData({
      ...baseFields(NOW),
      user: JSON.stringify({ id: "123", first_name: "X" }),
    });
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "INVALID_USER" });
  });

  it("rejects empty input and empty token", () => {
    expect(validateTelegramInitData("", getTestToken())).toEqual({
      ok: false,
      error: "MALFORMED",
    });
    expect(validateTelegramInitData(signInitData(baseFields(NOW)), "")).toEqual({
      ok: false,
      error: "MALFORMED",
    });
  });

  it("passes through start_param only after validation", () => {
    const raw = signInitData({ ...baseFields(NOW), start_param: "fridge_scan" });
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.startParam).toBe("fridge_scan");
  });

  it("evil start_param surviving validation is rejected by the sanitizer boundary", async () => {
    // Validator proves authenticity, NOT safety: exchange must sanitize.
    const { parseStartParam } = await import("../src/startParam.js");
    const evil = "../../etc/passwd";
    const raw = signInitData({ ...baseFields(NOW), start_param: evil });
    const res = validateTelegramInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.startParam).toBe(evil);
    expect(parseStartParam(res.identity.startParam).kind).toBe("invalid");
  });
});
