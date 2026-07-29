import { useMemo } from 'react';
import { displayContainerSize, displayPlantName } from './plantDisplay';
import { useLocale } from './i18n';

export function usePlantDisplay() {
  const { locale } = useLocale();
  return useMemo(
    () => ({
      locale,
      plant: (name: string, spanishName?: string | null) => displayPlantName(name, locale, spanishName),
      size: (size: string) => displayContainerSize(size, locale)
    }),
    [locale]
  );
}
