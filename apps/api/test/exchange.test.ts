import { describe, it, expect } from "vitest";
import { createMemoryRepos, createMemoryStore, type Db, type Repos } from "@user-platform/db";
import {
  ExchangeError,
  buildDisplayName,
  exchangeIdentity,
  validatePlatformIdentity,
} from "../src/services/exchange.js";
import { signInitData, telegramFields } from "./signer.js";

const TOKEN = "test-telegram-token-1234567890";

function memoryDb(): { db: Db; repos: Repos } {
  const noop = { query: async () => ({ rows: [], rowCount: 0 }) };
  const db: Db = {
    query: noop.query,
    withTransaction: (fn) => fn({ query: noop.query }),
    close: async () => {},
  };
  return { db, repos: createMemoryRepos(createMemoryStore()) };
}

function deps(overrides: Partial<Parameters<typeof exchangeIdentity>[0]> = {}) {
  const { db, repos } = memoryDb();
  return {
    db,
    repos,
    telegramBotToken: TOKEN,
    maxBotToken: "test-max-token-1234567890",
    ...overrides,
  };
}

const IDENTITY = {
  provider: "telegram" as const,
  providerUserId: "4242",
  username: "ivan_p",
  firstName: "Иван",
  lastName: "Петров",
  languageCode: "ru",
};

describe("validatePlatformIdentity", () => {
  it("accepts valid signed telegram data", () => {
    const raw = signInitData(telegramFields(Math.floor(Date.now() / 1000)), TOKEN);
    const id = validatePlatformIdentity(
      { telegramBotToken: TOKEN, maxBotToken: "x" },
      "telegram",
      raw,
    );
    expect(id.providerUserId).toBe("4242");
    expect(id.username).toBe("ivan_p");
  });

  it("rejects tampered data", () => {
    const raw = signInitData(telegramFields(Math.floor(Date.now() / 1000)), TOKEN).replace(
      "ivan_p",
      "mallory",
    );
    expect(() =>
      validatePlatformIdentity({ telegramBotToken: TOKEN, maxBotToken: "x" }, "telegram", raw),
    ).toThrowError(ExchangeError);
    try {
      validatePlatformIdentity({ telegramBotToken: TOKEN, maxBotToken: "x" }, "telegram", raw);
    } catch (err) {
      expect((err as ExchangeError).code).toBe("INVALID_PLATFORM_DATA");
    }
  });

  it("rejects expired data", () => {
    const raw = signInitData(telegramFields(Math.floor(Date.now() / 1000) - 7200), TOKEN);
    try {
      validatePlatformIdentity({ telegramBotToken: TOKEN, maxBotToken: "x" }, "telegram", raw);
      expect.unreachable();
    } catch (err) {
      expect((err as ExchangeError).code).toBe("PLATFORM_DATA_EXPIRED");
    }
  });

  it("rejects unconfigured provider", () => {
    const raw = signInitData(telegramFields(Math.floor(Date.now() / 1000)), TOKEN);
    expect(() =>
      validatePlatformIdentity({ telegramBotToken: "", maxBotToken: "" }, "max", raw),
    ).toThrowError(/not configured/);
  });
});

describe("buildDisplayName", () => {
  it("prefers full name, falls back to username, then guest", () => {
    expect(buildDisplayName({ firstName: "Иван", lastName: "Петров", username: "ivan_p" })).toBe(
      "Иван Петров",
    );
    expect(buildDisplayName({ username: "ivan_p" })).toBe("ivan_p");
    expect(buildDisplayName({})).toBe("Гость");
  });
});

describe("exchangeIdentity (memory)", () => {
  it("new user gets account + welcome bonus + session", async () => {
    const d = deps();
    const out = await exchangeIdentity(d, IDENTITY);
    expect(out.isNewUser).toBe(true);
    expect(out.availableBalance).toBe(10);
    expect(out.displayName).toBe("Иван Петров");
    expect(out.sessionToken.length).toBeGreaterThan(20);
    const ledger = await d.repos.ledger.listByUser(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      out.userId,
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 10, balanceAfter: 10, reason: "welcome_bonus" });
    const profile = await d.repos.profiles.getByUserId(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      out.userId,
    );
    expect(profile?.displayName).toBe("Иван Петров");
  });

  it("returning user keeps UUID and gets no second bonus", async () => {
    const d = deps();
    const first = await exchangeIdentity(d, IDENTITY);
    const second = await exchangeIdentity(d, IDENTITY);
    expect(second.isNewUser).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.availableBalance).toBe(10);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    const ledger = await d.repos.ledger.listByUser(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      first.userId,
    );
    expect(ledger).toHaveLength(1);
  });

  it("10 parallel first-logins create one user and one bonus", async () => {
    const d = deps();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => exchangeIdentity(d, IDENTITY)),
    );
    const userIds = new Set(outcomes.map((o) => o.userId));
    expect(userIds.size).toBe(1);
    expect(outcomes.filter((o) => o.isNewUser)).toHaveLength(1);
    const ledger = await d.repos.ledger.listByUser(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      outcomes[0].userId,
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(10);
  });

  it("evil start_param is sanitized to empty, explicit wins over signed", async () => {
    const d = deps();
    const evil = await exchangeIdentity(d, { ...IDENTITY, rawStartParam: "../../etc/passwd" });
    const acq = await d.repos.acquisitions.getByUserProvider(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      evil.userId,
      "telegram",
    );
    expect(acq?.startParam).toBe("");
    const d2 = deps();
    const good = await exchangeIdentity(
      d2,
      { ...IDENTITY, providerUserId: "9999", rawStartParam: "campaign_42" },
      { explicitStartParam: "fridge_scan" },
    );
    const acq2 = await d2.repos.acquisitions.getByUserProvider(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      good.userId,
      "telegram",
    );
    expect(acq2?.startParam).toBe("fridge_scan");
  });

  it("first-seen acquisition is never overwritten", async () => {
    const d = deps();
    const first = await exchangeIdentity(d, { ...IDENTITY, rawStartParam: "fridge_scan" });
    await exchangeIdentity(d, { ...IDENTITY, rawStartParam: "campaign_7" });
    const acq = await d.repos.acquisitions.getByUserProvider(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      first.userId,
      "telegram",
    );
    expect(acq?.startParam).toBe("fridge_scan");
  });
});
