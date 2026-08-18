import { useT } from '../lib/i18n';

export function EmailCcSection({
  value,
  onChange,
  disabled
}: {
  value: string;
  onChange: (next: string) => void;
  toEmail?: string;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <div>
      <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
        {t('invoice.ccEmail')}
      </label>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('invoice.ccPlaceholder')}
        className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800 text-xs"
      />
    </div>
  );
}
