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

/** True when names match exactly or one contains the other (e.g. "Crimson Fire" ↔ "Crimson Fire Loropetalum"). */
export function plantNamesMatch(orderName: string, inventoryName: string): boolean {
  const a = normalizePlantName(orderName);
  const b = normalizePlantName(inventoryName);
  if (a === b) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 3 && longer.includes(shorter)) return true;

  const words = shorter.split(' ').filter((w) => w.length >= 2);
  if (words.length >= 2) {
    return words.every((word) => longer.includes(word));
  }

  const setA = normalizedWordSet(orderName);
  const setB = normalizedWordSet(inventoryName);
  if (setA.size === 0 || setB.size === 0) return false;

  let overlap = 0;
  setA.forEach((w) => {
    if (setB.has(w)) overlap += 1;
  });

  // Accept close botanical variants (e.g. asian jasmine vs asiatic jasmine).
  return overlap >= Math.min(setA.size, setB.size);
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
  'bb': 'b&b',
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
  return plants.filter(
    (p) =>
      plantNamesMatch(plantName, p.plantName) &&
      normalizeContainerSize(p.containerSize, weights) === normSize
  );
}
