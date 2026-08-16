import { FormEvent, useEffect, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { PaymentMethod } from '../types';
import { useT } from '../lib/i18n';

export type ManualPaymentMethod = Exclude<PaymentMethod, 'stripe' | 'quickbooks'>;

const METHODS: ManualPaymentMethod[] = ['check', 'ach', 'wire', 'cc'];

interface MarkPaidModalProps {
  title: string;
  subtitle?: string;
  amountLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (payment: { method: ManualPaymentMethod; reference?: string }) => void | Promise<void>;
}

export function paymentMethodLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  method?: PaymentMethod | null
): string {
  if (!method) return '';
  const key = `paymentMethod.${method}`;
  const label = t(key);
  return label === key ? method : label;
}

export function formatPaymentRecord(
  t: (key: string, vars?: Record<string, string | number>) => string,
  method?: PaymentMethod | null,
  reference?: string | null
): string {
  if (!method) return '';
  const label = paymentMethodLabel(t, method);
  if (reference?.trim()) {
    if (method === 'check') return t('paymentMethod.checkWithNumber', { number: reference.trim() });
    return `${label} · ${t('paymentMethod.ref', { ref: reference.trim() })}`;
  }
  return label;
}

export function MarkPaidModal({
  title,
  subtitle,
  amountLabel,
  busy,
  onCancel,
  onConfirm
}: MarkPaidModalProps) {
  const t = useT();
  const [method, setMethod] = useState<ManualPaymentMethod>('check');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMethod('check');
    setReference('');
    setError(null);
  }, [title]);

  const referenceRequired = method === 'check';
  const referenceLabel =
    method === 'check'
      ? t('paymentMethod.checkNumber')
      : method === 'cc'
        ? t('paymentMethod.ccReference')
        : t('paymentMethod.reference');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ref = reference.trim();
    if (referenceRequired && !ref) {
      setError(t('paymentMethod.checkNumberRequired'));
      return;
    }
    setError(null);
    await onConfirm({ method, reference: ref || undefined });
  }

  return (
    <div className="fixed inset-0 z-[80] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
      >
        <div className="px-5 py-4 bg-ink-950 text-white flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-black tracking-tight flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-300 shrink-0" />
              {title}
            </h3>
            {subtitle && <p className="text-[11px] text-slate-300 mt-1 leading-relaxed">{subtitle}</p>}
            {amountLabel && (
              <p className="text-xs font-bold text-emerald-300 mt-1.5">{amountLabel}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-600 mb-2">
              {t('paymentMethod.howPaid')}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMethod(m);
                    setError(null);
                  }}
                  className={`px-3 py-2.5 rounded-xl text-xs font-bold border transition-colors ${
                    method === m
                      ? 'bg-ink-700 text-white border-ink-700'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-ink-300'
                  }`}
                >
                  {paymentMethodLabel(t, m)}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-xs">
            <span className="font-bold text-slate-600">
              {referenceLabel}
              {referenceRequired ? ' *' : ` (${t('common.optional')})`}
            </span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={
                method === 'check'
                  ? t('paymentMethod.checkNumberPlaceholder')
                  : t('paymentMethod.referencePlaceholder')
              }
              className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl text-sm"
              autoFocus
            />
          </label>

          {error && (
            <p className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex gap-2 justify-end bg-slate-50/80">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-2 rounded-xl text-xs font-bold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
          >
            {busy ? t('common.pleaseWait') : t('paymentMethod.confirmPaid')}
          </button>
        </div>
      </form>
    </div>
  );
}
