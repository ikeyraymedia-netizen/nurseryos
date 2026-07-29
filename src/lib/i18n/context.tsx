import { createContext, useContext, useEffect, useMemo, ReactNode } from 'react';
import { AppLocale, DEFAULT_LOCALE, LOCALE_STORAGE_KEY, normalizeLocale } from './types';
import en from './translations/en';
import es from './translations/es';

type Vars = Record<string, string | number>;

function getNested(dict: object, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function translate(locale: AppLocale, key: string, vars?: Vars): string {
  const dict = locale === 'es' ? es : en;
  let text = getNested(dict, key) ?? getNested(en, key) ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value));
    }
  }
  return text;
}

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: string, vars?: Vars) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  onLocaleChange,
  children
}: {
  locale: AppLocale;
  onLocaleChange?: (locale: AppLocale) => void;
  children: ReactNode;
}) {
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: (next) => {
        const normalized = normalizeLocale(next);
        try {
          localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
        } catch {
          /* ignore */
        }
        onLocaleChange?.(normalized);
      },
      t: (key, vars) => translate(locale, key, vars)
    }),
    [locale, onLocaleChange]
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function readStoredLocale(): AppLocale {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key, vars) => translate(DEFAULT_LOCALE, key, vars)
    };
  }
  return ctx;
}

export function useT(): LocaleContextValue['t'] {
  return useLocale().t;
}
