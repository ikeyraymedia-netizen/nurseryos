import { useId } from 'react';
import { PURCHASE_CATEGORY_PRESETS } from '../lib/purchaseCategories';

interface PurchaseCategoryFieldProps {
  value: string;
  onChange: (category: string) => void;
  className?: string;
}

/**
 * Category field: pick a suggestion or type any custom description.
 * Text input + datalist — no Custom select mode (that was snapping to Other).
 */
export function PurchaseCategoryField({
  value,
  onChange,
  className = ''
}: PurchaseCategoryFieldProps) {
  const listId = useId();

  return (
    <label className={`block ${className}`}>
      <span className="text-[9px] font-bold uppercase text-slate-500">Category</span>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Pick or type…"
        className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
        autoComplete="off"
      />
      <datalist id={listId}>
        {PURCHASE_CATEGORY_PRESETS.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
    </label>
  );
}
