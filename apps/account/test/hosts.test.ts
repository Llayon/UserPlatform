import { describe, it, expect } from "vitest";
import { detectHost } from "../src/hosts.js";

function telegramGlobal(overrides: Record<string, unknown> = {}) {
  return {
    window: {
      Telegram: {
        WebApp: {
          initData: "auth_date=1&hash=abc",
          initDataUnsafe: {
            start_param: "fridge_scan",
            user: { first_name: "Иван", username: "ivan_p", photo_url: "https://t.me/pic" },
          },
          colorScheme: "dark",
          safeAreaInset: { top: 10, bottom: 20, left: 0, right: 0 },
          ready: () => {},
          close: () => {},
          BackButton: { show: () => {}, hide: () => {}, onClick: () => {}, offClick: () => {} },
          ...overrides,
        },
      },
    },
  };
}

describe("detectHost", () => {
  it("detects Telegram with preview, theme and safe area", () => {
    const host = detectHost(telegramGlobal());
    expect(host.kind).toBe("telegram");
    expect(host.initDataRaw).toBe("auth_date=1&hash=abc");
    expect(host.startParam).toBe("fridge_scan");
    expect(host.userPreview).toMatchObject({ firstName: "Иван", username: "ivan_p" });
    expect(host.colorScheme).toBe("dark");
    expect(host.safeArea).toMatchObject({ top: 10, bottom: 20 });
    expect(() => host.ready()).not.toThrow();
  });

  it("detects MAX via bare window.WebApp", () => {
    const host = detectHost({
      window: {
        WebApp: {
          initData: "auth_date=2&hash=def",
          initDataUnsafe: { start_param: "wardrobe_add", user: { first_name: "Макс" } },
          colorScheme: "light",
          ready: () => {},
        },
      },
    });
    expect(host.kind).toBe("max");
    expect(host.initDataRaw).toBe("auth_date=2&hash=def");
    expect(host.startParam).toBe("wardrobe_add");
    expect(host.userPreview).toMatchObject({ firstName: "Макс" });
  });

  it("falls back to browser when no bridge exists", () => {
    const host = detectHost({ window: {} });
    expect(host.kind).toBe("browser");
    expect(host.initDataRaw).toBe("");
    expect(host.userPreview).toBeNull();
    expect(() => host.ready()).not.toThrow();
  });

  it("never mistakes partial Telegram globals for MAX", () => {
    const host = detectHost({ window: { Telegram: {}, WebApp: { initData: "x" } } });
    expect(host.kind).toBe("browser");
  });

  it("survives malformed globals without throwing", () => {
    expect(
      detectHost({ window: { Telegram: { WebApp: { initData: 42, colorScheme: "neon" } } } }).kind,
    ).toBe("telegram");
    expect(detectHost(null).kind).toBe("browser");
    expect(detectHost(undefined).kind).toBe("browser");
    const throwing = {
      get window(): never {
        throw new Error("boom");
      },
    };
    expect(detectHost(throwing).kind).toBe("browser");
  });

  it("back-button calls are safe no-ops when bridge methods are missing", () => {
    const host = detectHost(telegramGlobal({ BackButton: undefined }));
    expect(() => host.showBackButton(() => {})).not.toThrow();
    expect(() => host.hideBackButton()).not.toThrow();
  });
});
