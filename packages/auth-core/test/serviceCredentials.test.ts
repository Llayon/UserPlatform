import { describe, it, expect } from "vitest";
import {
  generateServiceToken,
  hashServiceSecret,
  parseServiceToken,
  verifyServiceSecret,
} from "../src/serviceCredentials.js";

describe("service credentials", () => {
  it("generates ups_<keyId>_<secret> with ≥128-bit secret entropy", () => {
    const gen = generateServiceToken();
    expect(gen.token.startsWith("ups_")).toBe(true);
    const parsed = parseServiceToken(gen.token);
    expect(parsed?.keyId).toBe(gen.keyId);
    expect(parsed?.secret).toBe(gen.secret);
    // 32 bytes → 43 base64url chars (256 bits).
    expect(gen.secret.length).toBeGreaterThanOrEqual(43);
  });

  it("malformed tokens rejected cheaply", () => {
    expect(parseServiceToken("")).toBeNull();
    expect(parseServiceToken("garbage")).toBeNull();
    expect(parseServiceToken("Bearer ups_x_y")).toBeNull();
    expect(parseServiceToken("ups_short_x")).toBeNull();
    expect(parseServiceToken(`ups_${"k".repeat(65)}_secretsecretsecret12`)).toBeNull();
    expect(parseServiceToken("x".repeat(300))).toBeNull();
  });

  it("hash-verify round-trips, wrong secret fails", () => {
    const gen = generateServiceToken();
    const hash = hashServiceSecret(gen.secret);
    expect(verifyServiceSecret(gen.secret, hash)).toBe(true);
    expect(verifyServiceSecret(`${gen.secret}x`, hash)).toBe(false);
    expect(verifyServiceSecret("", hash)).toBe(false);
  });

  it("keyId is non-secret lookup, secret never derivable from hash", () => {
    const gen = generateServiceToken();
    const hash = hashServiceSecret(gen.secret);
    expect(hash).not.toContain(gen.secret);
    expect(hash).not.toContain(gen.keyId);
  });
});
