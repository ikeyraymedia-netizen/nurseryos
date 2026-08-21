import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import { ContainerWeight, InventoryPlant } from '../types';

export function normalizePlantName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

const WORD_EQUIVALENTS: Record<string, string> = {
  asian: 'asiatic',
  asiatic: 'asiatic',
  jap: 'japanese',
  japanese: 'japanese',
  dwarf: 'dwarf',
  variegated: 'variegated'
};

function normalizeToken(token: string): string {
  const cleaned = token.replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '';
  if (WORD_EQUIVALENTS[cleaned]) return WORD_EQUIVALENTS[cleaned];
  if (cleaned.endsWith('es') && cleaned.length > 4) return cleaned.slice(0, -2);
  if (cleaned.endsWith('s') && cleaned.length > 3) return cleaned.slice(0, -1);
  return cleaned;
}

function normalizedWordSet(name: string): Set<string> {
  return new Set(
    normalizePlantName(name)
      .split(' ')
      .map(normalizeToken)
      .filter(Boolean)
  );
}

/**
 * Prefer specific cultivar matches over generic genus-only rows.
 * - Exact names match.
 * - Abbreviated orders match longer inventory names ("Crimson Fire" → "Crimson Fire Loropetalum").
 * - Do NOT match a longer order to a shorter single-word inventory
 *   ("Hydrangea Limelight" must not auto-link to bare "Hydrangea").
 */
export function plantNamesMatch(orderName: string, inventoryName: string): boolean {
  const a = normalizePlantName(orderName);
  const b = normalizePlantName(inventoryName);
  if (!a || !b) return false;
  if (a === b) return true;

  const orderWords = normalizedWordSet(orderName);
  const inventoryWords = normalizedWordSet(inventoryName);
  if (orderWords.size === 0 || inventoryWords.size === 0) return false;

  // Order is an abbreviated form of the inventory name.
  const orderSubsetOfInventory = [...orderWords].every((w) => inventoryWords.has(w));
  if (orderSubsetOfInventory) return true;

  // Inventory is a multi-word subset of the order (not a bare genus like "Hydrangea").
  const inventorySubsetOfOrder = [...inventoryWords].every((w) => orderWords.has(w));
  if (inventorySubsetOfOrder && inventoryWords.size >= 2) return true;

  return false;
}

/** Higher is better. Exact name wins; then closer word coverage / specificity. */
export function plantNameMatchScore(orderName: string, inventoryName: string): number {
  const a = normalizePlantName(orderName);
  const b = normalizePlantName(inventoryName);
  if (!a || !b) return 0;
  if (a === b) return 10_000;

  if (!plantNamesMatch(orderName, inventoryName)) return 0;

  const orderWords = normalizedWordSet(orderName);
  const inventoryWords = normalizedWordSet(inventoryName);
  let overlap = 0;
  orderWords.forEach((w) => {
    if (inventoryWords.has(w)) overlap += 1;
  });

  const wordCountGap = Math.abs(orderWords.size - inventoryWords.size);
  // Prefer more shared words and inventory names whose specificity is closest to the order.
  return overlap * 100 - wordCountGap * 25 + Math.min(inventoryWords.size, 20);
}

const SIZE_ALIASES: Record<string, string> = {
  '#1': '#1',
  '1g': '#1',
  '1 gal': '#1',
  '1 gallon': '#1',
  '1-gallon': '#1',
  '#3': '#3',
  '3g': '#3',
  '3 gal': '#3',
  '3 gallon': '#3',
  '3-gallon': '#3',
  '#5': '#5',
  '5g': '#5',
  '5 gal': '#5',
  '5 gallon': '#5',
  '#7': '#7',
  '7g': '#7',
  '#10': '#10',
  '10g': '#10',
  '#15': '#15',
  '15g': '#15',
  '#30': '#30',
  '30g': '#30',
  '#45': '#45',
  '45g': '#45',
  '#65': '#65',
  '65g': '#65',
  '#100': '#100',
  '100g': '#100',
  bb: 'b&b',
  'b&b': 'b&b',
  'balled and burlapped': 'b&b',
  '4 inch': '4 inch',
  '4"': '4 inch',
  '4in': '4 inch',
  '6 inch': '6 inch',
  '6"': '6 inch',
  tray: 'tray',
  flat: 'tray',
  other: 'other'
};

export function normalizeContainerSize(
  size: string,
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): string {
  const raw = size.trim().toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');
  if (SIZE_ALIASES[raw]) return SIZE_ALIASES[raw];

  for (const w of weights) {
    const id = w.id.toLowerCase();
    const label = w.label.toLowerCase();
    const name = w.name.toLowerCase();
    if (raw === id || raw === label || raw === name) return id;
    if (name.includes(raw) || raw.includes(id)) return id;
  }

  return raw;
}

export function findMatchingInventoryPlants(
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string,
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): InventoryPlant[] {
  const normSize = normalizeContainerSize(containerSize, weights);
  return plants
    .filter(
      (p) =>
        plantNamesMatch(plantName, p.plantName) &&
        normalizeContainerSize(p.containerSize, weights) === normSize
    )
    .sort(
      (a, b) =>
        plantNameMatchScore(plantName, b.plantName) - plantNameMatchScore(plantName, a.plantName) ||
        a.plantName.localeCompare(b.plantName)
    );
}
