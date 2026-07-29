import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, X } from 'lucide-react';
import { Vendor, VendorBill, VendorBillLine } from '../types';
import { useT } from '../lib/i18n';
import {
  emptyBillLine,
  isPlantPurchaseCategory,
  purchaseCategoryLabel,
  resolvePurchaseCategory
} from '../lib/purchaseCategories';
import { PurchaseCategoryField } from './PurchaseCategoryField';
import { CREATE_NEW_VENDOR, VendorPicker } from './VendorPicker';

type BillFormLine = {
  id?: string;
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  category: string;
};

function billToFormLines(bill: VendorBill): BillFormLine[] {
  const items = bill.items || [];
  if (items.length === 0) return [emptyBillLine()];
  return items.map((line) => ({
    id: line.id,
    plantName: line.plantName || '',
    containerSize: line.containerSize || '',
    quantity: line.quantity || 0,
    unitCost: line.unitCost || 0,
    category: purchaseCategoryLabel(
      line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
    )
  }));
}

function money(n: number) {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

interface BillEditModalProps {
  bill: VendorBill;
  vendors: Vendor[];
  busy?: boolean;
  canCreateVendor?: boolean;
  onClose: () => void;
  onSave: (updated: VendorBill) => Promise<void>;
}

export function BillEditModal({
  bill,
  vendors,
  busy,
  canCreateVendor = true,
  onClose,
  onSave
}: BillEditModalProps) {
  const t = useT();
  const [vendorId, setVendorId] = useState(bill.vendorId || '');
  const [newVendorName, setNewVendorName] = useState('');
  const [billDate, setBillDate] = useState(bill.billDate || '');
  const [dueDate, setDueDate] = useState(bill.dueDate || '');
  const [vendorInvoice, setVendorInvoice] = useState(bill.vendorInvoiceNumber || '');
  const [notes, setNotes] = useState(bill.notes || '');
  const [lines, setLines] = useState<BillFormLine[]>(() => billToFormLines(bill));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVendorId(bill.vendorId || '');
    setNewVendorName('');
    setBillDate(bill.billDate || '');
    setDueDate(bill.dueDate || '');
    setVendorInvoice(bill.vendorInvoiceNumber || '');
    setNotes(bill.notes || '');
    setLines(billToFormLines(bill));
    setError(null);
  }, [bill]);

  const pickerVendors = useMemo(() => {
    if (!bill.vendorId) return vendors;
    if (vendors.some((v) => v.id === bill.vendorId)) return vendors;
    return [
      {
        id: bill.vendorId,
        name: bill.vendorName || bill.vendorId,
        createdAt: bill.createdAt,
        updatedAt: bill.updatedAt
      },
      ...vendors
    ];
  }, [vendors, bill]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();

    let vendor = pickerVendors.find((v) => v.id === vendorId) || null;
    if (vendorId === CREATE_NEW_VENDOR) {
      if (!newVendorName.trim()) {
        setError(t('purchasing.enterVendorName'));
        return;
      }
    } else if (!vendor && vendorId === bill.vendorId) {
      vendor = {
        id: bill.vendorId,
        name: bill.vendorName,
        createdAt: bill.createdAt,
        updatedAt: bill.updatedAt
      };
    } else if (!vendor) {
      setError(t('purchasing.pickSavedVendor'));
      return;
    }

    const items = lines
      .map((l, idx) => ({
        id: l.id || `vbl-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        plantName: l.plantName.trim(),
        containerSize: isPlantPurchaseCategory(l.category)
          ? l.containerSize.trim() || 'Other'
          : l.containerSize.trim(),
        quantity: Math.max(0, Number(l.quantity) || 0),
        unitCost: Math.max(0, Number(l.unitCost) || 0),
        category: resolvePurchaseCategory(l.category)
      }))
      .filter((l) => l.plantName && l.quantity > 0) as VendorBillLine[];

    if (items.length === 0) {
      setError(t('purchasing.addLineRequired'));
      return;
    }

    const vendorName =
      vendorId === CREATE_NEW_VENDOR ? newVendorName.trim() : vendor!.name;
    const resolvedVendorId =
      vendorId === CREATE_NEW_VENDOR ? CREATE_NEW_VENDOR : vendor!.id;

    try {
      setError(null);
      await onSave({
        ...bill,
        vendorId: resolvedVendorId,
        vendorName,
        billDate: billDate || bill.billDate,
        dueDate: dueDate.trim() || undefined,
        vendorInvoiceNumber: vendorInvoice.trim() || undefined,
        notes: notes.trim() || undefined,
        items
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('purchasing.somethingWentWrong'));
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-slate-950/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('purchasing.editBill')}
      onClick={onClose}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden flex flex-col"
      >
        <div className="px-5 py-4 bg-ink-950 text-white flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-black tracking-tight flex items-center gap-2">
              <Pencil className="h-4 w-4 text-ink-300 shrink-0" />
              {t('purchasing.editBill')}
            </h3>
            <p className="text-[11px] text-slate-300 mt-1 truncate">
              {bill.billNumber} · {bill.vendorName} · {money(bill.grandTotal)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto flex-1 bg-ink-50/30">
          {error && (
            <p className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
          {bill.invoicePhotoUrl && (
            <a
              href={bill.invoicePhotoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-[11px] font-bold text-ink-700 hover:underline"
            >
              {t('purchasing.viewScannedInvoice')}
            </a>
          )}

          <div className="grid sm:grid-cols-2 gap-2 items-start">
            <VendorPicker
              vendors={pickerVendors}
              vendorId={vendorId}
              newVendorName={newVendorName}
              onVendorIdChange={setVendorId}
              onNewVendorNameChange={setNewVendorName}
              allowCreate={canCreateVendor}
            />
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('purchasing.billDate')}</span>
              <input
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('purchasing.dueDate')}</span>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('purchasing.vendorInvoiceNumber')}</span>
              <input
                value={vendorInvoice}
                onChange={(e) => setVendorInvoice(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </label>
          </div>

          <div className="space-y-2">
            {lines.map((line, idx) => (
              <div
                key={line.id || idx}
                className="rounded-lg border border-slate-100 bg-white p-2 space-y-1.5"
              >
                <div className="grid grid-cols-12 gap-1.5 items-start">
                  <input
                    value={line.plantName}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, plantName: e.target.value };
                      setLines(next);
                    }}
                    placeholder={t('purchasing.description')}
                    className="col-span-11 sm:col-span-7 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                  <div className="col-span-11 sm:col-span-4">
                    <PurchaseCategoryField
                      value={line.category}
                      onChange={(category) => {
                        const next = [...lines];
                        next[idx] = { ...line, category };
                        setLines(next);
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                    className="col-span-1 text-rose-600 flex items-center justify-center pt-2"
                    disabled={lines.length === 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-12 gap-1.5">
                  {isPlantPurchaseCategory(line.category) && (
                    <label className="col-span-4 block">
                      <span className="text-[9px] font-bold uppercase text-slate-500">
                        {t('purchasing.size')}
                      </span>
                      <input
                        value={line.containerSize}
                        onChange={(e) => {
                          const next = [...lines];
                          next[idx] = { ...line, containerSize: e.target.value };
                          setLines(next);
                        }}
                        placeholder={t('purchasing.sizePlaceholder')}
                        className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                      />
                    </label>
                  )}
                  <label
                    className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                  >
                    <span className="text-[9px] font-bold uppercase text-slate-500">
                      {t('common.qty')}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = { ...line, quantity: Number(e.target.value) || 0 };
                        setLines(next);
                      }}
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                  </label>
                  <label
                    className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                  >
                    <span className="text-[9px] font-bold uppercase text-slate-500">
                      {t('purchasing.costEach')}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitCost}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                        setLines(next);
                      }}
                      placeholder="0.00"
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLines([...lines, emptyBillLine()])}
              className="text-[11px] font-bold text-ink-700"
            >
              {t('purchasing.addLine')}
            </button>
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('purchasing.notes')}
            rows={2}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2 bg-white shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy ? t('common.pleaseWait') : t('purchasing.saveBill')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
