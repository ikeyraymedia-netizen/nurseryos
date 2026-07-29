export type AppLocale = 'en' | 'es';

export const DEFAULT_LOCALE: AppLocale = 'en';

export const LOCALE_STORAGE_KEY = 'nurseryos-locale';

export function normalizeLocale(value: unknown): AppLocale {
  return value === 'es' ? 'es' : 'en';
}
