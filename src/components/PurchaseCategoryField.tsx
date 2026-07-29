import { useEffect, useState } from 'react';
import {
  PURCHASE_CATEGORY_PRESETS,
  isPresetPurchaseCategory
} from '../lib/purchaseCategories';
import { useT } from '../lib/i18n';

const CATEGORY_I18N_KEYS: Record<(typeof PURCHASE_CATEGORY_PRESETS)[number], string> = {
  Plants: 'category.plants',
  'Soil / media': 'category.soil',
  'Containers / trays': 'category.containers',
  Chemicals: 'category.chemicals',
  Fertilizer: 'category.fertilizer',
  Freight: 'category.freight',
  Fuel: 'category.fuel',
  'Tools / equipment': 'category.tools',
  'General supplies': 'category.supplies',
  Other: 'category.other'
};

interface PurchaseCategoryFieldProps {
  value: string;
  onChange: (category: string) => void;
  className?: string;
}

/**
 * Category: choose from the list, or switch to Custom and type any description.
 * Mode is local state so the control never snaps back to "Other".
 */
export function PurchaseCategoryField({
  value,
  onChange,
  className = ''
}: PurchaseCategoryFieldProps) {
  const t = useT();
  const [mode, setMode] = useState<'list' | 'custom'>(() =>
    value.trim() && !isPresetPurchaseCategory(value) ? 'custom' : 'list'
  );

  useEffect(() => {
    if (value.trim() && isPresetPurchaseCategory(value)) {
      setMode('list');
    }
  }, [value]);

  const listValue = isPresetPurchaseCategory(value) ? value : 'Plants';

  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-bold uppercase text-slate-500">{t('category.label')}</span>
        <div className="inline-flex rounded-md border border-ink-200 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              setMode('list');
              if (!isPresetPurchaseCategory(value)) onChange('Plants');
            }}
            className={`px-2 py-0.5 text-[10px] font-bold ${
              mode === 'list' ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
            }`}
          >
            {t('category.list')}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('custom');
              if (isPresetPurchaseCategory(value)) onChange('');
            }}
            className={`px-2 py-0.5 text-[10px] font-bold ${
              mode === 'custom' ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
            }`}
          >
            {t('category.custom')}
          </button>
        </div>
      </div>

      {mode === 'list' ? (
        <select
          value={listValue}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
        >
          {PURCHASE_CATEGORY_PRESETS.map((label) => (
            <option key={label} value={label}>
              {t(CATEGORY_I18N_KEYS[label])}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={isPresetPurchaseCategory(value) ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('category.typeCustom')}
          className="w-full px-2 py-1.5 border border-ink-300 rounded-lg text-xs bg-white ring-1 ring-ink-100"
          autoFocus
        />
      )}
    </div>
  );
}
