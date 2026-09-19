/**
 * Development-only mock personas (BROWSER / dev mode, §33).
 * NEVER reachable in production — the route layer gates on
 * PLATFORM_ALLOW_DEV_AUTH + NODE_ENV !== "production".
 * IDs are deterministic (stable across restarts for dev UX).
 */
import type { IdentityProvider } from "@user-platform/db";

export interface DevPersona {
  name: string;
  provider: IdentityProvider;
  providerUserId: string;
  username: string;
  firstName: string;
  languageCode: string;
}

const PERSONAS: DevPersona[] = [
  {
    name: "telegram-user-1",
    provider: "telegram",
    providerUserId: "dev-tg-1001",
    username: "dev_tg_1",
    firstName: "Тест",
    languageCode: "ru",
  },
  {
    name: "telegram-user-2",
    provider: "telegram",
    providerUserId: "dev-tg-1002",
    username: "dev_tg_2",
    firstName: "Тест2",
    languageCode: "ru",
  },
  {
    name: "max-user-1",
    provider: "max",
    providerUserId: "dev-max-2001",
    username: "dev_max_1",
    firstName: "Макс",
    languageCode: "ru",
  },
  {
    name: "browser-user-1",
    provider: "web",
    providerUserId: "dev-web-3001",
    username: "dev_web_1",
    firstName: "Браузер",
    languageCode: "ru",
  },
];

export function listDevPersonas(): DevPersona[] {
  return PERSONAS.map((p) => ({ ...p }));
}

export function getDevPersona(name: string): DevPersona | undefined {
  const found = PERSONAS.find((p) => p.name === name);
  return found ? { ...found } : undefined;
}
