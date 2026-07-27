import { useEffect, useState } from 'react';
import {
  PURCHASE_CATEGORY_PRESETS,
  isPresetPurchaseCategory
} from '../lib/purchaseCategories';

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
  const [mode, setMode] = useState<'list' | 'custom'>(() =>
    value.trim() && !isPresetPurchaseCategory(value) ? 'custom' : 'list'
  );

  // If parent/AI sets a known preset, show list mode.
  useEffect(() => {
    if (value.trim() && isPresetPurchaseCategory(value)) {
      setMode('list');
    }
  }, [value]);

  const listValue = isPresetPurchaseCategory(value) ? value : 'Plants';

  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-bold uppercase text-slate-500">Category</span>
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
            List
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
            Custom
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
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={isPresetPurchaseCategory(value) ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your category…"
          className="w-full px-2 py-1.5 border border-ink-300 rounded-lg text-xs bg-white ring-1 ring-ink-100"
          autoFocus
        />
      )}
    </div>
  );
}
