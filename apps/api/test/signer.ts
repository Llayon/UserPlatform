/**
 * Local initData signer for tests (same documented HMAC-SHA256 WebAppData
 * scheme as auth-core vectors). Signs with the token the test config uses.
 */
import crypto from "node:crypto";

export function signInitData(fields: Record<string, string>, token: string): string {
  const pairs = Object.entries(fields)
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(pairs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function telegramFields(authDate: number, userId = 4242): Record<string, string> {
  return {
    auth_date: String(authDate),
    query_id: "test-qid",
    user: JSON.stringify({
      id: userId,
      first_name: "Иван",
      last_name: "Петров",
      username: "ivan_p",
      language_code: "ru",
    }),
  };
}
