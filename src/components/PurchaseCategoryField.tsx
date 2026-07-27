import { useEffect, useRef, useState } from 'react';
import {
  CUSTOM_CATEGORY_VALUE,
  PURCHASE_CATEGORY_PRESETS,
  isPresetPurchaseCategory
} from '../lib/purchaseCategories';

interface PurchaseCategoryFieldProps {
  value: string;
  onChange: (category: string) => void;
  className?: string;
}

function presetSelectValue(category: string): string {
  const raw = String(category || '').trim();
  if (!raw || raw === CUSTOM_CATEGORY_VALUE) return CUSTOM_CATEGORY_VALUE;
  const match = PURCHASE_CATEGORY_PRESETS.find((p) => p.toLowerCase() === raw.toLowerCase());
  return match || CUSTOM_CATEGORY_VALUE;
}

/** Preset category select with free-text custom description. */
export function PurchaseCategoryField({
  value,
  onChange,
  className = ''
}: PurchaseCategoryFieldProps) {
  const [customMode, setCustomMode] = useState(() => {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (raw === CUSTOM_CATEGORY_VALUE) return true;
    return !isPresetPurchaseCategory(raw);
  });
  const customInputRef = useRef<HTMLInputElement>(null);

  // Parent/AI set a real preset → leave custom mode.
  useEffect(() => {
    if (value.trim() && value !== CUSTOM_CATEGORY_VALUE && isPresetPurchaseCategory(value)) {
      setCustomMode(false);
    }
  }, [value]);

  const isCustom =
    customMode ||
    value === CUSTOM_CATEGORY_VALUE ||
    (!!value.trim() && !isPresetPurchaseCategory(value));

  const selectValue = isCustom ? CUSTOM_CATEGORY_VALUE : presetSelectValue(value);
  const customText = value === CUSTOM_CATEGORY_VALUE ? '' : value;

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
            setCustomMode(true);
            // Store a sentinel so the select stays on Custom (empty used to snap to Other).
            onChange(CUSTOM_CATEGORY_VALUE);
          } else {
            setCustomMode(false);
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
            value={customText}
            onChange={(e) => {
              setCustomMode(true);
              onChange(e.target.value);
            }}
            placeholder="Type a description…"
            className="mt-0.5 w-full px-2 py-1.5 border border-ink-200 rounded-lg text-xs bg-white"
          />
        </label>
      )}
    </div>
  );
}
