import { describe, it, expect } from "vitest";
import { validateMaxInitData } from "../src/max.js";
import { validateTelegramInitData } from "../src/telegram.js";
import { signInitData, getTestToken, baseFields } from "./vectors.js";

const NOW = 1_700_000_000;

function maxFields(authDate: number, userId = 123): Record<string, string> {
  return {
    ...baseFields(authDate, userId),
    chat: JSON.stringify({ id: 5, type: "DIALOG" }),
    start_param: "wardrobe_add",
  };
}

describe("validateMaxInitData", () => {
  it("accepts valid signed MAX data", () => {
    const raw = signInitData(maxFields(NOW));
    const res = validateMaxInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.provider).toBe("max");
    expect(res.identity.providerUserId).toBe("123");
    expect(res.identity.startParam).toBe("wardrobe_add");
  });

  it("rejects tampered payload", () => {
    const raw = signInitData(maxFields(NOW)).replace("wardrobe_add", "wardrobe_outfit");
    const res = validateMaxInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "INVALID_SIGNATURE" });
  });

  it("rejects data older than MAX 1h recommendation", () => {
    const raw = signInitData(maxFields(NOW - 3700));
    const res = validateMaxInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "EXPIRED" });
  });

  it("rejects unknown chat type", () => {
    const raw = signInitData({
      ...maxFields(NOW),
      chat: JSON.stringify({ id: 5, type: "SUPERGROUP" }),
    });
    const res = validateMaxInitData(raw, getTestToken(), { nowSeconds: NOW });
    expect(res).toEqual({ ok: false, error: "MALFORMED" });
  });

  it("accepts all documented chat types", () => {
    for (const type of ["DIALOG", "CHAT", "CHANNEL"]) {
      const raw = signInitData({
        ...maxFields(NOW),
        chat: JSON.stringify({ id: 5, type }),
      });
      const res = validateMaxInitData(raw, getTestToken(), { nowSeconds: NOW });
      expect(res.ok).toBe(true);
    }
  });

  it("same numeric ID on telegram and max yields different provider namespaces", () => {
    const tg = signInitData(baseFields(NOW, 777));
    const mx = signInitData(maxFields(NOW, 777));
    const tgRes = validateTelegramInitData(tg, getTestToken(), { nowSeconds: NOW });
    const mxRes = validateMaxInitData(mx, getTestToken(), { nowSeconds: NOW });
    expect(tgRes.ok && mxRes.ok).toBe(true);
    if (!tgRes.ok || !mxRes.ok) return;
    // Same numeric ID, but namespaced identity keys differ:
    expect(`${tgRes.identity.provider}:${tgRes.identity.providerUserId}`).toBe("telegram:777");
    expect(`${mxRes.identity.provider}:${mxRes.identity.providerUserId}`).toBe("max:777");
    expect(`${tgRes.identity.provider}:${tgRes.identity.providerUserId}`).not.toBe(
      `${mxRes.identity.provider}:${mxRes.identity.providerUserId}`,
    );
  });
});
