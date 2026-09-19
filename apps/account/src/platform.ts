import { createPlatformClient } from "@user-platform/platform-client";

const baseUrl = (import.meta.env.VITE_PLATFORM_API_URL as string | undefined) ?? "";

export const platform = createPlatformClient({ baseUrl });

export function pluralCredits(n: number): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return "AI-кредит";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "AI-кредита";
  return "AI-кредитов";
}

const OPERATION_LABELS: Record<string, string> = {
  "fridge.scan": "Холодильник · скан",
  "fridge.recipe": "Холодильник · рецепт",
  "wardrobe.scan": "Гардероб · скан",
  "wardrobe.outfit": "Гардероб · образ",
  "wardrobe.shopping_check": "Гардероб · проверка",
  "interior.analyze": "Интерьер · анализ",
};

export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation;
}

const STATUS_LABELS: Record<string, string> = {
  committed: "готово",
  reserved: "в обработке",
  released: "возвращено",
  failed: "не удалось",
};

export function usageStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function dayLabel(iso: string, nowMs = Date.now()): string {
  const day = new Date(iso);
  const now = new Date(nowMs);
  const sameDay =
    day.getFullYear() === now.getFullYear() &&
    day.getMonth() === now.getMonth() &&
    day.getDate() === now.getDate();
  if (sameDay) return "Сегодня";
  return day.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
