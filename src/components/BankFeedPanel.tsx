import { FormEvent, useEffect, useMemo, useState } from 'react';
import { CreditCard, Landmark, Upload } from 'lucide-react';
import { BankFeedAccountKind, BankFeedTransaction, Vendor, VendorBill } from '../types';
import { AppPermissions } from '../lib/permissions';
import { useT } from '../lib/i18n';
import { PURCHASE_CATEGORY_PRESETS } from '../lib/purchaseCategories';
import { addVendor } from '../lib/vendors';
import {
  confirmBankFeedExpense,
  findBillMatchesForFeed,
  ignoreBankFeedTransaction,
  importBankFeedCsv,
  matchBankFeedToBill,
  subscribeToBankFeedTransactions,
  updateBankFeedTransaction
} from '../lib/bankFeed';
import { PurchaseCategoryField } from './PurchaseCategoryField';

function money(n: number) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD'
  }).format(n);
}

interface BankFeedPanelProps {
  vendors: Vendor[];
  bills: VendorBill[];
  permissions: AppPermissions;
  search: string;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
}

export function BankFeedPanel({
  vendors,
  bills,
  permissions,
  search,
  onStatus,
  onError
}: BankFeedPanelProps) {
  const t = useT();
  const [rows, setRows] = useState<BankFeedTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [accountKind, setAccountKind] = useState<BankFeedAccountKind>('card');
  const [accountLabel, setAccountLabel] = useState('');
  const [showInflows, setShowInflows] = useState(false);
  const [draftCategory, setDraftCategory] = useState<Record<string, string>>({});
  const [draftVendorId, setDraftVendorId] = useState<Record<string, string>>({});
  const [creatingVendorFor, setCreatingVendorFor] = useState<string | null>(null);
  const [newVendorName, setNewVendorName] = useState('');

  useEffect(() => {
    return subscribeToBankFeedTransactions(setRows);
  }, []);

  const unreviewed = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.status !== 'unreviewed') return false;
      if (!showInflows && r.amount >= 0) return false;
      if (!q) return true;
      return [r.description, r.merchant, r.vendorName, r.accountLabel]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search, showInflows]);

  const unreviewedCount = rows.filter((r) => r.status === 'unreviewed' && r.amount < 0).length;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    onError('');
    try {
      await fn();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : t('purchasing.somethingWentWrong'));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(file: File) {
    await run(async () => {
      const text = await file.text();
      const result = await importBankFeedCsv({
        text,
        accountKind,
        accountLabel:
          accountLabel.trim() ||
          (accountKind === 'card' ? t('purchasing.feedDefaultCard') : t('purchasing.feedDefaultBank')),
        vendors
      });
      onStatus(
        t('purchasing.feedImportResult', {
          imported: result.imported,
          duplicates: result.duplicates,
          skipped: result.skipped
        })
      );
    });
  }

  function vendorIdFor(tx: BankFeedTransaction): string {
    return draftVendorId[tx.id] || tx.vendorId || '';
  }

  function categoryFor(tx: BankFeedTransaction): string {
    return draftCategory[tx.id] || tx.category || 'Other';
  }

  async function handleConfirm(tx: BankFeedTransaction) {
    await run(async () => {
      const vendorId = vendorIdFor(tx);
      const vendor = vendors.find((v) => v.id === vendorId);
      if (!vendor) throw new Error(t('purchasing.feedPickVendor'));
      await confirmBankFeedExpense({
        tx,
        vendor,
        category: categoryFor(tx)
      });
      onStatus(t('purchasing.feedTagged', { vendor: vendor.name }));
    });
  }

  async function handleMatchBill(tx: BankFeedTransaction, bill: VendorBill) {
    await run(async () => {
      const vendor = vendors.find((v) => v.id === bill.vendorId);
      if (!vendor) throw new Error(t('purchasing.feedPickVendor'));
      await matchBankFeedToBill({ tx, bill, vendor });
      onStatus(t('purchasing.feedMatchedBill', { bill: bill.billNumber }));
    });
  }

  async function handleCreateVendor(e: FormEvent, tx: BankFeedTransaction) {
    e.preventDefault();
    await run(async () => {
      if (!permissions.canEditVendors) {
        throw new Error(t('purchasing.needVendorPermission'));
      }
      const name = newVendorName.trim() || tx.merchant || tx.description.slice(0, 40);
      if (!name) throw new Error(t('purchasing.enterVendorName'));
      const id = await addVendor({ name });
      setDraftVendorId((prev) => ({ ...prev, [tx.id]: id }));
      await updateBankFeedTransaction({
        ...tx,
        vendorId: id,
        vendorName: name,
        matchConfidence: 'manual'
      });
      setCreatingVendorFor(null);
      setNewVendorName('');
      onStatus(t('purchasing.feedVendorCreated', { name }));
    });
  }

  if (!permissions.canManageVendorBills) {
    return (
      <p className="text-xs text-slate-500 py-8 text-center">{t('purchasing.feedNeedPermission')}</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-black text-slate-900">{t('purchasing.feedTitle')}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{t('purchasing.feedHint')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAccountKind('card')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border ${
              accountKind === 'card'
                ? 'bg-ink-700 text-white border-ink-700'
                : 'bg-white text-ink-800 border-ink-200'
            }`}
          >
            <CreditCard className="h-3.5 w-3.5" />
            {t('purchasing.feedKindCard')}
          </button>
          <button
            type="button"
            onClick={() => setAccountKind('bank')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border ${
              accountKind === 'bank'
                ? 'bg-ink-700 text-white border-ink-700'
                : 'bg-white text-ink-800 border-ink-200'
            }`}
          >
            <Landmark className="h-3.5 w-3.5" />
            {t('purchasing.feedKindBank')}
          </button>
        </div>

        <input
          type="text"
          value={accountLabel}
          onChange={(e) => setAccountLabel(e.target.value)}
          placeholder={t('purchasing.feedAccountLabelPlaceholder')}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
        />

        <label
          className={`inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-ink-700 text-white text-xs font-bold cursor-pointer ${
            busy ? 'opacity-50 pointer-events-none' : ''
          }`}
        >
          <Upload className="h-3.5 w-3.5" />
          {t('purchasing.feedUploadCsv')}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-700">
          {t('purchasing.feedUnreviewed', { n: unreviewedCount })}
        </p>
        <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={showInflows}
            onChange={(e) => setShowInflows(e.target.checked)}
            className="rounded border-gray-300"
          />
          {t('purchasing.feedShowInflows')}
        </label>
      </div>

      <div className="space-y-2 max-h-[560px] overflow-y-auto">
        {unreviewed.length === 0 ? (
          <p className="text-xs text-gray-500 py-8 text-center">{t('purchasing.feedEmpty')}</p>
        ) : (
          unreviewed.map((tx) => {
            const billMatches = findBillMatchesForFeed(
              { ...tx, vendorId: vendorIdFor(tx) || tx.vendorId },
              bills
            );
            const isExpense = tx.amount < 0;
            return (
              <div
                key={tx.id}
                className="border border-gray-100 rounded-xl p-3 space-y-2 bg-white"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">
                      {tx.merchant || tx.description}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {tx.date}
                      {tx.accountLabel ? ` · ${tx.accountLabel}` : ''}
                      {tx.matchConfidence && tx.matchConfidence !== 'none'
                        ? ` · ${t('purchasing.feedMatch', { level: tx.matchConfidence })}`
                        : ''}
                    </p>
                    {tx.merchant && tx.merchant !== tx.description && (
                      <p className="text-[10px] text-gray-400 mt-0.5 truncate">{tx.description}</p>
                    )}
                  </div>
                  <p
                    className={`text-sm font-black shrink-0 ${
                      isExpense ? 'text-rose-800' : 'text-emerald-800'
                    }`}
                  >
                    {money(tx.amount)}
                  </p>
                </div>

                {isExpense && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[9px] font-bold uppercase text-slate-500 mb-1">
                          {t('purchasing.vendors')}
                        </label>
                        <select
                          value={vendorIdFor(tx)}
                          onChange={(e) => {
                            const id = e.target.value;
                            if (id === '__new__') {
                              setCreatingVendorFor(tx.id);
                              setNewVendorName(tx.merchant || '');
                              return;
                            }
                            setDraftVendorId((prev) => ({ ...prev, [tx.id]: id }));
                            const vendor = vendors.find((v) => v.id === id);
                            void updateBankFeedTransaction({
                              ...tx,
                              vendorId: id || null,
                              vendorName: vendor?.name || null,
                              matchConfidence: id ? 'manual' : 'none'
                            });
                          }}
                          className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-xs"
                        >
                          <option value="">{t('purchasing.feedSelectVendor')}</option>
                          {vendors.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                          {permissions.canEditVendors && (
                            <option value="__new__">{t('purchasing.feedCreateVendor')}</option>
                          )}
                        </select>
                      </div>
                      <PurchaseCategoryField
                        value={categoryFor(tx)}
                        onChange={(cat) =>
                          setDraftCategory((prev) => ({ ...prev, [tx.id]: cat }))
                        }
                      />
                    </div>

                    {creatingVendorFor === tx.id && (
                      <form
                        onSubmit={(e) => void handleCreateVendor(e, tx)}
                        className="flex flex-wrap gap-2 items-end"
                      >
                        <div className="flex-1 min-w-[140px]">
                          <label className="block text-[9px] font-bold uppercase text-slate-500 mb-1">
                            {t('purchasing.vendorName')}
                          </label>
                          <input
                            value={newVendorName}
                            onChange={(e) => setNewVendorName(e.target.value)}
                            className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-xs"
                            autoFocus
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={busy}
                          className="px-3 py-2 rounded-lg bg-ink-700 text-white text-[10px] font-bold"
                        >
                          {t('purchasing.addVendor')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setCreatingVendorFor(null)}
                          className="px-3 py-2 text-[10px] font-bold text-slate-600"
                        >
                          {t('common.cancel')}
                        </button>
                      </form>
                    )}

                    {billMatches.length > 0 && (
                      <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-2.5 py-2 space-y-1">
                        <p className="text-[10px] font-bold uppercase text-amber-800">
                          {t('purchasing.feedPossibleBills')}
                        </p>
                        {billMatches.map((bill) => (
                          <button
                            key={bill.id}
                            type="button"
                            disabled={busy}
                            onClick={() => void handleMatchBill(tx, bill)}
                            className="w-full text-left text-[11px] font-semibold text-amber-950 hover:underline"
                          >
                            {bill.billNumber} · {money(bill.grandTotal)} ·{' '}
                            {t('purchasing.feedMatchExisting')}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}

                <div className="flex flex-wrap gap-2">
                  {isExpense && (
                    <button
                      type="button"
                      disabled={busy || !vendorIdFor(tx)}
                      onClick={() => void handleConfirm(tx)}
                      className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-ink-700 text-white disabled:opacity-50"
                    >
                      {t('purchasing.feedConfirm')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await ignoreBankFeedTransaction(tx);
                        onStatus(t('purchasing.feedIgnored'));
                      })
                    }
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg border border-gray-200 text-slate-600"
                  >
                    {t('purchasing.feedIgnore')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[10px] text-slate-400">
        {t('purchasing.feedCategoriesHint', {
          sample: PURCHASE_CATEGORY_PRESETS.slice(0, 4).join(', ')
        })}
      </p>
    </div>
  );
}
