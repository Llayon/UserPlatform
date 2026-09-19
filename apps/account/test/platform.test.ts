import { describe, it, expect } from "vitest";
import { dayLabel, operationLabel, pluralCredits, usageStatusLabel } from "../src/platform.js";

describe("account helpers", () => {
  it("pluralizes Russian credits correctly", () => {
    expect(pluralCredits(1)).toBe("AI-кредит");
    expect(pluralCredits(2)).toBe("AI-кредита");
    expect(pluralCredits(4)).toBe("AI-кредита");
    expect(pluralCredits(5)).toBe("AI-кредитов");
    expect(pluralCredits(0)).toBe("AI-кредитов");
    expect(pluralCredits(10)).toBe("AI-кредитов");
    expect(pluralCredits(11)).toBe("AI-кредитов");
    expect(pluralCredits(21)).toBe("AI-кредит");
    expect(pluralCredits(111)).toBe("AI-кредитов");
    expect(pluralCredits(1000)).toBe("AI-кредитов");
  });

  it("labels known operations, passes through unknown", () => {
    expect(operationLabel("fridge.scan")).toBe("Холодильник · скан");
    expect(operationLabel("wardrobe.outfit")).toBe("Гардероб · образ");
    expect(operationLabel("future.thing")).toBe("future.thing");
  });

  it("labels usage statuses without inventing amounts", () => {
    expect(usageStatusLabel("committed")).toBe("готово");
    expect(usageStatusLabel("reserved")).toBe("в обработке");
    expect(usageStatusLabel("released")).toBe("возвращено");
    expect(usageStatusLabel("failed")).toBe("не удалось");
    expect(usageStatusLabel("weird")).toBe("weird");
  });

  it("groups today vs older dates in Russian", () => {
    const now = new Date("2026-09-19T12:00:00.000Z").getTime();
    expect(dayLabel("2026-09-19T08:00:00.000Z", now)).toBe("Сегодня");
    // A week older is "yesterday"-proof in every timezone between -12 and +14.
    expect(dayLabel("2026-09-10T12:00:00.000Z", now)).toContain("сентября");
  });
});
