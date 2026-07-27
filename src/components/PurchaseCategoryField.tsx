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

/** Preset category select with optional free-text custom category. */
export function PurchaseCategoryField({
  value,
  onChange,
  className = ''
}: PurchaseCategoryFieldProps) {
  const selectValue = categorySelectValue(value);
  const isCustom = selectValue === CUSTOM_CATEGORY_VALUE;

  return (
    <div className={`space-y-1 ${className}`}>
      <select
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_CATEGORY_VALUE) {
            onChange(isPresetPurchaseCategory(value) ? '' : value);
          } else {
            onChange(next);
          }
        }}
        className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
      >
        {PURCHASE_CATEGORY_PRESETS.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
        <option value={CUSTOM_CATEGORY_VALUE}>Custom…</option>
      </select>
      {isCustom && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Your category name"
          className="w-full px-2 py-1.5 border border-ink-200 rounded-lg text-xs bg-white"
          autoFocus
        />
      )}
    </div>
  );
}
