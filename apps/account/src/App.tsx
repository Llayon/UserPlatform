import { useEffect, useMemo, useState } from "react";
import type { MeResponse } from "@user-platform/contracts";
import { PlatformApiError } from "@user-platform/platform-client";
import { detectHost, type HostAdapter } from "./hosts";
import { dayLabel, operationLabel, platform, pluralCredits, usageStatusLabel } from "./platform";

type Screen =
  | { name: "booting" }
  | { name: "persona" }
  | { name: "dashboard"; me: MeResponse; usage: UsageRow[] }
  | { name: "error"; message: string };

interface UsageRow {
  id: string;
  appSlug: string;
  operation: string;
  status: string;
  createdAt: string;
}

const PERSONAS = ["telegram-user-1", "telegram-user-2", "max-user-1", "browser-user-1"];

const SERVICES = [
  {
    emoji: "🍳",
    name: "Что приготовить",
    desc: "Скан холодильника и рецепты",
    open: true,
    key: "fridge",
  },
  {
    emoji: "👗",
    name: "Мой гардероб",
    desc: "Образы и разбор шкафа",
    open: false,
    key: "wardrobe",
  },
  { emoji: "🏠", name: "Интерьер", desc: "Анализ и идеи для дома", open: false, key: "interior" },
];

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0].toUpperCase() : "•";
}

export default function App() {
  const [host] = useState<HostAdapter>(() => detectHost());
  const [screen, setScreen] = useState<Screen>({ name: "booting" });

  useEffect(() => {
    document.documentElement.dataset.theme = host.colorScheme;
    host.ready();
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Existing session cookie → straight to dashboard.
      try {
        const me = await platform.me.get();
        if (cancelled) return;
        const usage = await platform.me.usage(50).catch(() => ({ usage: [] }));
        if (cancelled) return;
        setScreen({ name: "dashboard", me, usage: usage.usage });
        return;
      } catch (err) {
        if (err instanceof PlatformApiError && err.status !== 401) {
          if (!cancelled)
            setScreen({ name: "error", message: "Сервис недоступен. Попробуйте позже." });
          return;
        }
        // 401 → no session: exchange below.
      }
      if (host.kind === "browser" || !host.initDataRaw) {
        if (!cancelled) setScreen({ name: "persona" });
        return;
      }
      try {
        await platform.auth.exchangePlatform({
          platform: host.kind,
          initData: host.initDataRaw,
          startParam: host.startParam || undefined,
        });
        if (cancelled) return;
        const me = await platform.me.get();
        const usage = await platform.me.usage(50).catch(() => ({ usage: [] }));
        if (!cancelled) setScreen({ name: "dashboard", me, usage: usage.usage });
      } catch {
        if (!cancelled)
          setScreen({ name: "error", message: "Не удалось войти. Попробуйте позже." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  const safeStyle = useMemo(
    () => ({
      paddingTop: `max(0px, ${host.safeArea.top}px)`,
      paddingBottom: `max(0px, ${host.safeArea.bottom}px)`,
    }),
    [host],
  );

  const loginPersona = async (persona: string) => {
    setScreen({ name: "booting" });
    try {
      await platform.auth.exchangeDev(persona);
      const me = await platform.me.get();
      const usage = await platform.me.usage(50).catch(() => ({ usage: [] }));
      setScreen({ name: "dashboard", me, usage: usage.usage });
    } catch {
      setScreen({ name: "error", message: "Не удалось войти. Попробуйте позже." });
    }
  };

  const logout = async () => {
    try {
      await platform.auth.logout();
    } catch {
      // Session already gone — still reset UI.
    }
    setScreen(
      host.kind === "browser" || !host.initDataRaw ? { name: "persona" } : { name: "booting" },
    );
    if (host.kind !== "browser" && host.initDataRaw) window.location.reload();
  };

  if (screen.name === "booting") {
    return (
      <div className="app-shell" style={safeStyle} data-testid="booting">
        <div className="center-wrap">
          <div className="spinner" aria-hidden="true" />
          <p>Открываю аккаунт…</p>
        </div>
      </div>
    );
  }

  if (screen.name === "error") {
    return (
      <div className="app-shell" style={safeStyle} data-testid="error-screen">
        <div className="center-wrap">
          <div className="error-banner" role="alert" data-testid="error-banner">
            {screen.message}
          </div>
          <button className="btn" onClick={() => window.location.reload()} data-testid="retry-btn">
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (screen.name === "persona") {
    return (
      <div className="app-shell" style={safeStyle} data-testid="persona-screen">
        <div className="center-wrap">
          <h2 style={{ margin: 0 }}>Вход для разработки</h2>
          <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
            Выберите тестовый профиль
          </p>
          <div className="persona-list">
            {PERSONAS.map((p) => (
              <button
                key={p}
                className="btn btn-secondary"
                onClick={() => loginPersona(p)}
                data-testid={`persona-${p}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const days = new Map<string, UsageRow[]>();
  for (const row of screen.usage) {
    const label = dayLabel(row.createdAt);
    const list = days.get(label) ?? [];
    list.push(row);
    days.set(label, list);
  }

  return (
    <div className="app-shell" style={safeStyle} data-testid="dashboard">
      <header className="app-header">
        <div className="avatar" data-testid="avatar">
          {initials(screen.me.profile.displayName)}
        </div>
        <div>
          <h1 className="user-name" data-testid="display-name">
            {screen.me.profile.displayName || "Гость"}
          </h1>
          <p className="user-sub">Общий счёт для всех сервисов</p>
        </div>
      </header>

      <section className="balance-card" aria-label="Баланс">
        <p className="balance-label">Баланс</p>
        <p className="balance-value" data-testid="balance">
          {screen.me.balance.available} {pluralCredits(screen.me.balance.available)}
        </p>
      </section>

      <h2 className="section-title">Мои сервисы</h2>
      {SERVICES.map((s) =>
        s.open ? (
          <button key={s.key} className="service-card" data-testid={`service-${s.key}`}>
            <span className="service-emoji" aria-hidden="true">
              {s.emoji}
            </span>
            <span>
              <p className="service-name">{s.name}</p>
              <p className="service-desc">{s.desc}</p>
            </span>
            <span className="service-action">Открыть</span>
          </button>
        ) : (
          <div
            key={s.key}
            className="service-card"
            data-testid={`service-${s.key}`}
            aria-disabled="true"
          >
            <span className="service-emoji" aria-hidden="true">
              {s.emoji}
            </span>
            <span>
              <p className="service-name">{s.name}</p>
              <p className="service-desc">{s.desc}</p>
            </span>
            <span className="service-action">Скоро</span>
          </div>
        ),
      )}

      <h2 className="section-title">История</h2>
      <div className="usage-list" data-testid="usage-list">
        {screen.usage.length === 0 && (
          <div className="empty-note">Пока пусто — загляните в «Что приготовить»</div>
        )}
        {[...days.entries()].map(([day, rows]) => (
          <div key={day}>
            <div className="usage-day">{day}</div>
            {rows.map((row) => (
              <div key={row.id} className="usage-row" data-testid={`usage-${row.id}`}>
                <span>{operationLabel(row.operation)}</span>
                <span className="usage-status">{usageStatusLabel(row.status)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="logout-row">
        <button className="btn btn-secondary" onClick={logout} data-testid="logout-btn">
          Выйти
        </button>
      </div>
    </div>
  );
}
