import type { InventoryPlant } from '../types';

export const AVAILABILITY_UNCATEGORIZED = 'Uncategorized';

/**
 * Categories that were auto-filled from container size (QB import).
 * Availability lists should group by the nursery’s entered section/category instead.
 */
export function isSizeDerivedCategory(raw?: string | null): boolean {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!v) return false;
  if (v === 'b&b' || v === 'b and b' || v === 'flats' || v === 'caliper' || v === 'tray') {
    return true;
  }
  if (/^#?\d+(\.\d+)?$/.test(v)) return true;
  if (/^\d+(\.\d+)?\s*(gal|gallon|gallons|g)$/.test(v)) return true;
  if (/^#\d+(\.\d+)?\s*(gal|gallon|gallons|g)?$/.test(v)) return true;
  return false;
}

/** Section/category for availability grouping — ignores gallon/size auto-labels. */
export function availabilityCategoryLabel(raw?: string | null): string {
  const v = String(raw || '').trim();
  if (!v || isSizeDerivedCategory(v)) return AVAILABILITY_UNCATEGORIZED;
  return v;
}

export function compareAvailabilityCategory(a: string, b: string): number {
  const aUncat = a === AVAILABILITY_UNCATEGORIZED;
  const bUncat = b === AVAILABILITY_UNCATEGORIZED;
  if (aUncat && !bUncat) return 1;
  if (!aUncat && bUncat) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

export function compareAvailabilityPlants(
  a: Pick<InventoryPlant, 'plantName' | 'containerSize' | 'category'>,
  b: Pick<InventoryPlant, 'plantName' | 'containerSize' | 'category'>
): number {
  const cat = compareAvailabilityCategory(
    availabilityCategoryLabel(a.category),
    availabilityCategoryLabel(b.category)
  );
  if (cat !== 0) return cat;
  const name = (a.plantName || '').localeCompare(b.plantName || '', undefined, {
    sensitivity: 'base'
  });
  if (name !== 0) return name;
  return (a.containerSize || '').localeCompare(b.containerSize || '', undefined, {
    sensitivity: 'base',
    numeric: true
  });
}

export function sortAvailabilityPlants<T extends Pick<InventoryPlant, 'plantName' | 'containerSize' | 'category'>>(
  plants: T[]
): T[] {
  return [...plants].sort(compareAvailabilityPlants);
}

/** Group by entered category (A–Z), plants A–Z within each group. Uncategorized last. */
export function groupPlantsByAvailabilityCategory<
  T extends Pick<InventoryPlant, 'plantName' | 'containerSize' | 'category'>
>(plants: T[]): Array<{ category: string; plants: T[] }> {
  const map = new Map<string, T[]>();
  for (const plant of sortAvailabilityPlants(plants)) {
    const category = availabilityCategoryLabel(plant.category);
    const list = map.get(category) || [];
    list.push(plant);
    map.set(category, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => compareAvailabilityCategory(a, b))
    .map(([category, grouped]) => ({ category, plants: grouped }));
}
