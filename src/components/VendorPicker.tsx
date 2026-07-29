import { Vendor } from '../types';
import { useT } from '../lib/i18n';

export const CREATE_NEW_VENDOR = '__create_new__';

interface VendorPickerProps {
  vendors: Vendor[];
  /** Selected saved vendor id, or empty when creating new. */
  vendorId: string;
  /** Name for a brand-new vendor (when create mode). */
  newVendorName: string;
  onVendorIdChange: (vendorId: string) => void;
  onNewVendorNameChange: (name: string) => void;
  /** Allow create-new mode. Default true. */
  allowCreate?: boolean;
  /** Optional AI-detected name hint shown above the picker. */
  aiHint?: string;
  matchLabel?: string;
  suggestions?: Vendor[];
  className?: string;
}

/**
 * Pick a saved vendor or create one on the spot for quick expense entry.
 */
export function VendorPicker({
  vendors,
  vendorId,
  newVendorName,
  onVendorIdChange,
  onNewVendorNameChange,
  allowCreate = true,
  aiHint,
  matchLabel,
  suggestions = [],
  className = ''
}: VendorPickerProps) {
  const t = useT();
  const creating = allowCreate && vendorId === CREATE_NEW_VENDOR;
  const sorted = [...vendors].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={`space-y-2 ${className}`}>
      {aiHint && (
        <p className="text-sm font-semibold text-slate-800">
          {t('vendor.aiRead')} <span className="text-ink-800">{aiHint}</span>
          {matchLabel && (
            <span className="ml-2 text-[10px] font-bold uppercase text-emerald-700">
              {matchLabel}
            </span>
          )}
        </p>
      )}

      {allowCreate && (
        <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (creating) onVendorIdChange('');
            }}
            className={`px-3 py-1.5 text-[11px] font-bold ${
              !creating ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
            }`}
          >
            {t('vendor.savedVendors')}
          </button>
          <button
            type="button"
            onClick={() => {
              onVendorIdChange(CREATE_NEW_VENDOR);
              if (!newVendorName.trim() && aiHint) onNewVendorNameChange(aiHint);
            }}
            className={`px-3 py-1.5 text-[11px] font-bold ${
              creating ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
            }`}
          >
            {t('vendor.createNew')}
          </button>
        </div>
      )}

      {creating ? (
        <label className="block text-xs">
          <span className="font-bold text-slate-600">{t('vendor.newVendorName')}</span>
          <input
            required
            value={newVendorName}
            onChange={(e) => onNewVendorNameChange(e.target.value)}
            placeholder={t('vendor.vendorPlaceholder')}
            className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            autoFocus
          />
        </label>
      ) : (
        <label className="block text-xs">
          <span className="font-bold text-slate-600">{t('vendor.vendor')}</span>
          <select
            required={!allowCreate}
            value={vendorId}
            onChange={(e) => onVendorIdChange(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          >
            <option value="">{t('vendor.selectSaved')}</option>
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {!creating && suggestions.length > 0 && !vendorId && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onVendorIdChange(v.id)}
              className="text-[10px] font-bold px-2 py-1 rounded-full bg-ink-50 text-ink-800 border border-ink-100"
            >
              {v.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
