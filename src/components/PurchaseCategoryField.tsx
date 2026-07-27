import { useEffect, useRef } from 'react';
import {
  CUSTOM_CATEGORY_VALUE,
  PURCHASE_CATEGORY_PRESETS,
  categorySelectValue,
  isPresetPurchaseCategory
} from '../lib/purchaseCategories';

interface PurchaseCategoryFieldProps {
  value: string;
  onChange: (category: string) => void;
  className?: string;
}

/** Preset category select with free-text custom description. */
export function PurchaseCategoryField({
  value,
  onChange,
  className = ''
}: PurchaseCategoryFieldProps) {
  const selectValue = categorySelectValue(value);
  const isCustom = selectValue === CUSTOM_CATEGORY_VALUE;
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isCustom) return;
    const id = window.setTimeout(() => customInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isCustom]);

  return (
    <div className={`space-y-1 ${className}`}>
      <select
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_CATEGORY_VALUE) {
            // Clear presets so the text field is ready for a custom description.
            onChange(isPresetPurchaseCategory(value) ? '' : value);
          } else {
            onChange(next);
          }
        }}
        className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
        aria-label="Category"
      >
        {PURCHASE_CATEGORY_PRESETS.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
        <option value={CUSTOM_CATEGORY_VALUE}>Custom…</option>
      </select>
      {isCustom && (
        <label className="block">
          <span className="text-[9px] font-bold uppercase text-slate-500">
            Custom category
          </span>
          <input
            ref={customInputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type a description…"
            className="mt-0.5 w-full px-2 py-1.5 border border-ink-200 rounded-lg text-xs bg-white"
          />
        </label>
      )}
    </div>
  );
}
