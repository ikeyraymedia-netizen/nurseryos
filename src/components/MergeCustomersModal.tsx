import { useMemo, useState } from 'react';
import { GitMerge, Search, X } from 'lucide-react';
import { Customer } from '../types';
import { buildMergedCustomer, mergeCustomers } from '../lib/customers';
import { useT } from '../lib/i18n';

interface MergeCustomersModalProps {
  keeper: Customer;
  customers: Customer[];
  onClose: () => void;
  onMerged: (result: {
    keeperId: string;
    removedName: string;
    remappedOrders: number;
    remappedDocuments: number;
  }) => void;
}

export function MergeCustomersModal({
  keeper,
  customers,
  onClose,
  onMerged
}: MergeCustomersModalProps) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [mergeId, setMergeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers
      .filter((c) => c.id !== keeper.id)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, keeper.id, search]);

  const other = customers.find((c) => c.id === mergeId) || null;
  const preview = other ? buildMergedCustomer(keeper, other) : null;

  async function handleMerge() {
    if (!mergeId || !other) {
      setError(t('customers.mergePickOther'));
      return;
    }
    const ok = window.confirm(
      t('customers.mergeConfirm', { keep: keeper.name, remove: other.name })
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const result = await mergeCustomers({ keeperId: keeper.id, mergeId });
      onMerged({
        keeperId: result.mergedCustomer.id,
        removedName: other.name,
        remappedOrders: result.remappedOrders,
        remappedDocuments: result.remappedDocuments
      });
    } catch (err: any) {
      setError(err?.message || t('customers.mergeFailed'));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <GitMerge className="h-5 w-5 text-ink-700 shrink-0" />
            <h3 className="font-bold text-gray-900 truncate">{t('customers.mergeTitle')}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-sm text-gray-600 leading-relaxed">{t('customers.mergeIntro', { name: keeper.name })}</p>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('customers.mergeSearch')}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
          </div>

          <select
            value={mergeId}
            onChange={(e) => setMergeId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
            disabled={busy}
          >
            <option value="">{t('customers.mergeSelect')}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.contactEmail ? ` · ${c.contactEmail}` : ''}
              </option>
            ))}
          </select>

          {preview && other ? (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3 space-y-2 text-xs">
              <p className="font-bold uppercase tracking-wide text-emerald-900">{t('customers.mergePreview')}</p>
              <PreviewRow label={t('customers.customerName')} value={preview.name} />
              <PreviewRow label={t('customers.email')} value={preview.contactEmail} />
              <PreviewRow label={t('customers.phone')} value={preview.phone} />
              <PreviewRow label={t('customers.billTo')} value={preview.billingAddress || preview.billingName} />
              <PreviewRow label={t('customers.shipTo')} value={preview.shippingAddress || preview.shippingName} />
              <PreviewRow label={t('customers.notes')} value={preview.notes} multiline />
              <p className="text-[10px] text-emerald-800 pt-1">{t('customers.mergeWillRelink')}</p>
            </div>
          ) : null}

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleMerge()}
            disabled={busy || !mergeId}
            className="px-4 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? t('common.pleaseWait') : t('customers.mergeAction')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewRow({
  label,
  value,
  multiline
}: {
  label: string;
  value?: string | null;
  multiline?: boolean;
}) {
  if (!value?.trim()) return null;
  return (
    <div>
      <span className="font-semibold text-gray-700">{label}: </span>
      {multiline ? (
        <pre className="whitespace-pre-wrap font-sans text-gray-600 mt-0.5">{value}</pre>
      ) : (
        <span className="text-gray-600">{value}</span>
      )}
    </div>
  );
}
