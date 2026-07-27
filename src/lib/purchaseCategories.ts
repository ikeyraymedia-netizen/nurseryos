import type { PurchaseLineCategory, PurchaseLineType } from '../types';

export const PURCHASE_LINE_TYPES: Array<{ id: PurchaseLineType; label: string }> = [
  { id: 'plant', label: 'Plant' },
  { id: 'supply', label: 'Supply' },
  { id: 'freight', label: 'Freight' },
  { id: 'other', label: 'Other' }
];

export const PURCHASE_CATEGORIES: Array<{ id: PurchaseLineCategory; label: string }> = [
  { id: 'plants', label: 'Plants' },
  { id: 'soil', label: 'Soil / media' },
  { id: 'containers', label: 'Containers / trays' },
  { id: 'chemicals', label: 'Chemicals' },
  { id: 'fertilizer', label: 'Fertilizer' },
  { id: 'freight', label: 'Freight' },
  { id: 'tools', label: 'Tools / equipment' },
  { id: 'supplies', label: 'General supplies' },
  { id: 'other', label: 'Other' }
];

const CATEGORY_IDS = new Set(PURCHASE_CATEGORIES.map((c) => c.id));
const TYPE_IDS = new Set(PURCHASE_LINE_TYPES.map((t) => t.id));

export function defaultCategoryForType(type: PurchaseLineType): PurchaseLineCategory {
  if (type === 'plant') return 'plants';
  if (type === 'freight') return 'freight';
  if (type === 'supply') return 'supplies';
  return 'other';
}

export function normalizePurchaseLineType(value: unknown): PurchaseLineType {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (TYPE_IDS.has(raw as PurchaseLineType)) return raw as PurchaseLineType;
  if (raw.includes('plant') || raw.includes('tree') || raw.includes('shrub')) return 'plant';
  if (raw.includes('freight') || raw.includes('shipping') || raw.includes('delivery')) {
    return 'freight';
  }
  if (
    raw.includes('supply') ||
    raw.includes('soil') ||
    raw.includes('pot') ||
    raw.includes('chemical') ||
    raw.includes('fertilizer')
  ) {
    return 'supply';
  }
  return 'other';
}

export function normalizePurchaseCategory(
  value: unknown,
  type: PurchaseLineType
): PurchaseLineCategory {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (CATEGORY_IDS.has(raw as PurchaseLineCategory)) return raw as PurchaseLineCategory;

  if (raw.includes('plant')) return 'plants';
  if (raw.includes('soil') || raw.includes('media') || raw.includes('mulch')) return 'soil';
  if (raw.includes('container') || raw.includes('pot') || raw.includes('tray')) {
    return 'containers';
  }
  if (raw.includes('chem') || raw.includes('spray') || raw.includes('pesticide')) {
    return 'chemicals';
  }
  if (raw.includes('fert')) return 'fertilizer';
  if (raw.includes('freight') || raw.includes('ship') || raw.includes('delivery')) {
    return 'freight';
  }
  if (raw.includes('tool') || raw.includes('equip')) return 'tools';
  if (raw.includes('supply')) return 'supplies';

  return defaultCategoryForType(type);
}

export function purchaseCategoryLabel(category?: string | null): string {
  const found = PURCHASE_CATEGORIES.find((c) => c.id === category);
  return found?.label || 'Other';
}

export function purchaseTypeLabel(type?: string | null): string {
  const found = PURCHASE_LINE_TYPES.find((t) => t.id === type);
  return found?.label || 'Other';
}

export function emptyBillLine(): {
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  lineType: PurchaseLineType;
  category: PurchaseLineCategory;
} {
  return {
    plantName: '',
    containerSize: '',
    quantity: 1,
    unitCost: 0,
    lineType: 'plant',
    category: 'plants'
  };
}
