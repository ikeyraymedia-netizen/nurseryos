/** Suggested categories — users can also type any custom label. */
export const PURCHASE_CATEGORY_PRESETS = [
  'Plants',
  'Soil / media',
  'Containers / trays',
  'Chemicals',
  'Fertilizer',
  'Freight',
  'Fuel',
  'Tools / equipment',
  'General supplies',
  'Other'
] as const;

const PRESET_LOOKUP = new Map(
  PURCHASE_CATEGORY_PRESETS.map((label) => [label.toLowerCase(), label])
);

/** Map older AI/id values onto preset labels. */
const LEGACY_CATEGORY_MAP: Record<string, string> = {
  plants: 'Plants',
  plant: 'Plants',
  soil: 'Soil / media',
  containers: 'Containers / trays',
  chemicals: 'Chemicals',
  fertilizer: 'Fertilizer',
  freight: 'Freight',
  fuel: 'Fuel',
  gas: 'Fuel',
  diesel: 'Fuel',
  tools: 'Tools / equipment',
  supplies: 'General supplies',
  other: 'Other',
  supply: 'General supplies'
};

export const CUSTOM_CATEGORY_VALUE = '__custom__';

export function isPresetPurchaseCategory(category: string): boolean {
  return PRESET_LOOKUP.has(category.trim().toLowerCase());
}

/** Plants category drives optional size / future inventory receive. */
export function isPlantPurchaseCategory(category?: string | null): boolean {
  const raw = String(category || '')
    .trim()
    .toLowerCase();
  return raw === 'plants' || raw === 'plant';
}

/**
 * Normalize AI / form input into a display category.
 * Known presets are canonicalized; anything else is kept as a custom label.
 */
export function normalizePurchaseCategory(value: unknown, lineTypeHint?: unknown): string {
  const raw = String(value || '').trim();
  if (raw) {
    const lower = raw.toLowerCase().replace(/\s+/g, '_');
    if (LEGACY_CATEGORY_MAP[lower]) return LEGACY_CATEGORY_MAP[lower];
    const preset = PRESET_LOOKUP.get(raw.toLowerCase());
    if (preset) return preset;
    // Keep custom categories (title-ish as entered)
    return raw;
  }

  const type = String(lineTypeHint || '')
    .trim()
    .toLowerCase();
  if (type.includes('plant')) return 'Plants';
  if (type.includes('freight') || type.includes('ship')) return 'Freight';
  if (type.includes('supply')) return 'General supplies';
  return 'Other';
}

export function purchaseCategoryLabel(category?: string | null): string {
  const raw = String(category || '').trim();
  if (!raw) return 'Other';
  return normalizePurchaseCategory(raw);
}

export function emptyBillLine(): {
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  category: string;
} {
  return {
    plantName: '',
    containerSize: '',
    quantity: 1,
    unitCost: 0,
    category: 'Plants'
  };
}

/** Select value for category UI: preset label or custom sentinel. */
export function categorySelectValue(category: string): string {
  const raw = String(category || '').trim();
  // Empty means the user chose Custom and is typing a description.
  if (!raw) return CUSTOM_CATEGORY_VALUE;
  if (isPresetPurchaseCategory(raw)) {
    return PRESET_LOOKUP.get(raw.toLowerCase()) || raw;
  }
  return CUSTOM_CATEGORY_VALUE;
}
