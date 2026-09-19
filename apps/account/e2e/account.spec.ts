import { test, expect, type Page } from "@playwright/test";

const ME = (overrides: Record<string, unknown> = {}) => ({
  user: {
    id: "123e4567-e89b-12d3-a456-426614174000",
    status: "active",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  profile: { displayName: "Иван Петров", avatarUrl: null, locale: "ru" },
  balance: { available: 10, reserved: 0 },
  ...overrides,
});

const EXCHANGE = {
  user: {
    id: "123e4567-e89b-12d3-a456-426614174000",
    status: "active",
    createdAt: "2026-09-19T00:00:00.000Z",
  },
  isNewUser: true,
  balance: 10,
  sessionExpiresAt: "2026-10-19T00:00:00.000Z",
};

const USAGE = [
  {
    id: "u1",
    appSlug: "fridge",
    operation: "fridge.scan",
    requestId: "r1",
    status: "committed",
    createdAt: new Date().toISOString(),
  },
  {
    id: "u2",
    appSlug: "wardrobe",
    operation: "wardrobe.outfit",
    requestId: "r2",
    status: "reserved",
    createdAt: new Date().toISOString(),
  },
];

async function mockApi(page: Page, me: Record<string, unknown> = ME(), usage: unknown[] = USAGE) {
  // Stateful mock mirroring reality: 401 until exchange sets the session.
  // (Playwright matches routes LIFO, so a single stateful handler per pattern.)
  let authed = false;
  await page.route("**/v1/auth/dev/exchange", async (route) => {
    authed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EXCHANGE),
    });
  });
  const unauthorized = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  await page.route("**/v1/me/balance", async (route) => {
    if (!authed) {
      await unauthorized(route);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify((me.balance as Record<string, unknown>) ?? {}),
    });
  });
  await page.route("**/v1/me/usage**", async (route) => {
    if (!authed) {
      await unauthorized(route);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ usage }),
    });
  });
  await page.route("**/v1/me", async (route) => {
    if (!authed) {
      await unauthorized(route);
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) });
  });
}

async function loginAs(page: Page, persona = "telegram-user-1") {
  await page.getByTestId("persona-screen").waitFor();
  await page.getByTestId(`persona-${persona}`).click();
  await page.getByTestId("dashboard").waitFor();
}

test.describe("account dashboard (mocked API)", () => {
  test("persona login → dashboard with balance, services, usage", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await loginAs(page);
    await expect(page.getByTestId("display-name")).toHaveText("Иван Петров");
    await expect(page.getByTestId("balance")).toHaveText("10 AI-кредитов");
    await expect(page.getByTestId("service-fridge")).toContainText("Открыть");
    await expect(page.getByTestId("service-wardrobe")).toContainText("Скоро");
    await expect(page.getByTestId("service-interior")).toContainText("Скоро");
    await expect(page.getByText("Холодильник · скан")).toBeVisible();
    await expect(page.getByText("Гардероб · образ")).toBeVisible();
  });

  test("balance pluralization variants", async ({ page }) => {
    for (const [available, text] of [
      [0, "0 AI-кредитов"],
      [1, "1 AI-кредит"],
      [2, "2 AI-кредита"],
      [1250, "1250 AI-кредитов"],
    ] as const) {
      await page.unrouteAll({ behavior: "wait" });
      await mockApi(page, ME({ balance: { available, reserved: 0 } }), []);
      await page.goto("/");
      await loginAs(page);
      await expect(page.getByTestId("balance")).toHaveText(text);
    }
  });

  test("empty usage shows friendly note", async ({ page }) => {
    await mockApi(page, ME(), []);
    await page.goto("/");
    await loginAs(page);
    await expect(page.getByText("Пока пусто")).toBeVisible();
  });

  test("exchange failure shows error banner with retry", async ({ page }) => {
    await page.route("**/v1/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
    );
    await page.route("**/v1/auth/dev/exchange", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );
    await page.goto("/");
    await page.getByTestId("persona-screen").waitFor();
    await page.getByTestId("persona-telegram-user-1").click();
    await expect(page.getByTestId("error-banner")).toBeVisible();
    await expect(page.getByTestId("retry-btn")).toBeVisible();
  });

  test("long Russian name does not overflow at 360px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockApi(
      page,
      ME({
        profile: {
          displayName: "Александрина Великолепная-Прекрасная из Санкт-Петербурга",
          avatarUrl: null,
          locale: "ru",
        },
      }),
    );
    await page.goto("/");
    await loginAs(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("viewports 390 and 430 render without horizontal overflow", async ({ page }) => {
    for (const [width, height] of [
      [390, 844],
      [430, 932],
    ] as const) {
      await page.context().clearCookies();
      await page.unrouteAll({ behavior: "wait" });
      await mockApi(page);
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await loginAs(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await expect(page.getByTestId("logout-btn")).toBeVisible();
    }
  });

  test("dark theme follows platform color scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockApi(page);
    await page.goto("/");
    await loginAs(page);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  });
});
