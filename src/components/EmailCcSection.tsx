import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { looksLikeEmail, parseCcEmails } from '../lib/email';
import { useT } from '../lib/i18n';

export function EmailCcSection({
  value,
  onChange,
  toEmail,
  disabled
}: {
  value: string;
  onChange: (next: string) => void;
  toEmail?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const { cc } = parseCcEmails(value, toEmail);

  function commit(raw: string) {
    const trimmed = raw.trim().replace(/,+$/, '');
    if (!trimmed) return;
    if (!looksLikeEmail(trimmed)) {
      setError(t('invoice.ccInvalid', { emails: trimmed }));
      return;
    }
    const next = parseCcEmails([...cc, trimmed].join(', '), toEmail).cc;
    onChange(next.join(', '));
    setDraft('');
    setError('');
  }

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 space-y-2">
      <div>
        <p className="font-black text-amber-950 uppercase tracking-wider text-[11px]">
          {t('invoice.ccEmail')}
        </p>
        <p className="text-[9px] text-amber-800 mt-0.5 leading-relaxed">
          {t('invoice.ccSectionHint')}
        </p>
      </div>

      {cc.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {cc.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 max-w-full rounded-lg bg-ink-50 border border-ink-100 px-2 py-1 text-[10px] font-semibold text-ink-900"
            >
              <span className="truncate">{email}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(cc.filter((row) => row !== email).join(', '))}
                className="shrink-0 text-ink-500 hover:text-ink-900 disabled:opacity-50"
                aria-label={t('common.delete')}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-slate-400">{t('invoice.ccEmpty')}</p>
      )}

      <div className="flex gap-1.5">
        <input
          type="email"
          value={draft}
          disabled={disabled}
          placeholder={t('invoice.ccAddPlaceholder')}
          onChange={(e) => {
            setDraft(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            }
          }}
          className="flex-1 min-w-0 px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800 text-xs"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => commit(draft)}
          className="inline-flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-xl bg-ink-700 hover:bg-ink-800 text-white text-[10px] font-black disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          {t('invoice.ccAdd')}
        </button>
      </div>
      {error ? <p className="text-[9px] text-rose-700">{error}</p> : null}
    </div>
  );
}
