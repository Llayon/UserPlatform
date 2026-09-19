import { describe, it, expect } from "vitest";
import { parseStartParam } from "../src/startParam.js";
import {
  createSessionToken,
  hashSessionToken,
  isSessionExpired,
  sessionExpiresAt,
} from "../src/sessions.js";

describe("parseStartParam", () => {
  it("classifies known acquisition tags", () => {
    for (const tag of ["fridge_scan", "wardrobe_add", "wardrobe_outfit", "interior_analyze"]) {
      expect(parseStartParam(tag)).toEqual({ kind: "known", value: tag });
    }
  });

  it("classifies campaign tags", () => {
    expect(parseStartParam("campaign_42")).toEqual({ kind: "campaign", value: "campaign_42" });
  });

  it("passes through safe generic values without executing anything", () => {
    expect(parseStartParam("hello123")).toEqual({ kind: "generic", value: "hello123" });
  });

  it("rejects traversal, URLs, JS and overlong input", () => {
    expect(parseStartParam("../../etc/passwd").kind).toBe("invalid");
    expect(parseStartParam("https://evil.example/x").kind).toBe("invalid");
    expect(parseStartParam("<script>alert(1)</script>").kind).toBe("invalid");
    expect(parseStartParam("a b").kind).toBe("invalid");
    expect(parseStartParam("x".repeat(65)).kind).toBe("invalid");
    expect(parseStartParam("").kind).toBe("invalid");
    expect(parseStartParam(undefined).kind).toBe("invalid");
    expect(parseStartParam("fridge_scan;DROP TABLE users").kind).toBe("invalid");
  });
});

describe("platform sessions (pure helpers)", () => {
  it("issues unique opaque tokens with stable hashes", () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a).not.toBe(b);
    expect(hashSessionToken(a)).toHaveLength(64);
    expect(hashSessionToken(a)).toBe(hashSessionToken(a));
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
    expect(hashSessionToken(a)).not.toContain(a.slice(0, 8));
  });

  it("computes expiry and detects expiration", () => {
    const issued = 1_700_000_000_000;
    const exp = sessionExpiresAt(issued, 3600);
    expect(exp).toBe(issued + 3_600_000);
    expect(isSessionExpired(exp, exp - 1)).toBe(false);
    expect(isSessionExpired(exp, exp)).toBe(true);
  });
});
