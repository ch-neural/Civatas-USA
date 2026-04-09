/**
 * UI locale store.
 *
 * Zustand store + localStorage persistence for the user-selected UI language.
 * The application is US-only; English is the source of truth and the default.
 * Additional locales (zh-TW today, ja / ko planned) can be selected via the
 * StatusBar language button — strings missing a translation fall back to the
 * English source value (handled inside `lib/i18n.ts`).
 *
 * Usage:
 *   const { locale, setLocale } = useLocaleStore();
 *   const t = useTr();   // preferred — see lib/i18n.ts
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

// All known UI locales. Add `"ja"` / `"ko"` here when those translations land.
export type UiLocale = "en" | "zh-TW";

// Cycle order for the StatusBar toggle button.
const LOCALE_CYCLE: UiLocale[] = ["en", "zh-TW"];

interface LocaleState {
  locale: UiLocale;
  setLocale: (l: UiLocale) => void;
  toggle: () => void;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set, get) => ({
      locale: "en", // English is the source of truth and the default
      setLocale: (locale) => set({ locale }),
      toggle: () => {
        const cur = get().locale;
        const idx = LOCALE_CYCLE.indexOf(cur);
        const next = LOCALE_CYCLE[(idx + 1) % LOCALE_CYCLE.length];
        set({ locale: next });
      },
    }),
    {
      name: "civatas-locale",
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const str = localStorage.getItem(name);
          return str ? JSON.parse(str) : null;
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          localStorage.removeItem(name);
        },
      },
    }
  )
);

/** Display label for each locale (used in the StatusBar toggle button). */
const LOCALE_LABEL: Record<UiLocale, string> = {
  "en":    "EN",
  "zh-TW": "中文",
};

/** Convenience helper: short label of the *next* locale in the cycle. */
export function nextLocaleLabel(current: UiLocale): string {
  const idx = LOCALE_CYCLE.indexOf(current);
  const next = LOCALE_CYCLE[(idx + 1) % LOCALE_CYCLE.length];
  return LOCALE_LABEL[next];
}
