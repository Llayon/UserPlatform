/**
 * Deterministic test-vector helper. Signs initData with the DOCUMENTED
 * algorithm (HMAC-SHA256 WebAppData scheme) using a fixed TEST token.
 * No network, no live bots. Vectors are reproducible by hand.
 */
import crypto from "node:crypto";

const TEST_TOKEN = "test-bot-token-1234567890:TEST";

export function signInitData(fields: Record<string, string>): string {
  const pairs = Object.entries(fields)
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TEST_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(pairs).digest("hex");
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

export function getTestToken(): string {
  return TEST_TOKEN;
}

export function baseFields(authDate: number, userId = 123): Record<string, string> {
  return {
    auth_date: String(authDate),
    query_id: "test-query-id",
    user: JSON.stringify({ id: userId, first_name: "Test", username: "tester" }),
  };
}
