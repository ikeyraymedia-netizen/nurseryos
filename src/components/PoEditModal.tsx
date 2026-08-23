import { FormEvent, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, X } from 'lucide-react';
import { PurchaseOrder, PurchaseOrderLine, Vendor } from '../types';
import { useT } from '../lib/i18n';

type PoFormLine = {
  id?: string;
  plantName: string;
  containerSize: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
};

function emptyFormLine(): PoFormLine {
  return {
    plantName: '',
    containerSize: '',
    quantityOrdered: 1,
    quantityReceived: 0,
    unitCost: 0
  };
}

function orderToFormLines(order: PurchaseOrder): PoFormLine[] {
  const items = order.items || [];
  if (items.length === 0) return [emptyFormLine()];
  return items.map((line) => ({
    id: line.id,
    plantName: line.plantName || '',
    containerSize: line.containerSize || '',
    quantityOrdered: line.quantityOrdered || 0,
    quantityReceived: line.quantityReceived || 0,
    unitCost: line.unitCost || 0
  }));
}

function money(n: number) {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

interface PoEditModalProps {
  order: PurchaseOrder;
  vendors: Vendor[];
  busy?: boolean;
  onClose: () => void;
  onSave: (updated: PurchaseOrder) => Promise<void>;
}

export function PoEditModal({ order, vendors, busy, onClose, onSave }: PoEditModalProps) {
  const t = useT();
  const hasReceipts = order.items.some((line) => (line.quantityReceived || 0) > 0);
  const [vendorId, setVendorId] = useState(order.vendorId || '');
  const [expectedDate, setExpectedDate] = useState(order.expectedDate || '');
  const [notes, setNotes] = useState(order.notes || '');
  const [lines, setLines] = useState<PoFormLine[]>(() => orderToFormLines(order));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVendorId(order.vendorId || '');
    setExpectedDate(order.expectedDate || '');
    setNotes(order.notes || '');
    setLines(orderToFormLines(order));
    setError(null);
  }, [order]);

  const pickerVendors = useMemo(() => {
    if (!order.vendorId) return vendors;
    if (vendors.some((v) => v.id === order.vendorId)) return vendors;
    return [
      {
        id: order.vendorId,
        name: order.vendorName || order.vendorId,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
      },
      ...vendors
    ];
  }, [vendors, order]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();

    const vendor = pickerVendors.find((v) => v.id === vendorId);
    if (!vendor) {
      setError(t('purchasing.pickVendor'));
      return;
    }

    const items: PurchaseOrderLine[] = lines
      .map((line, idx) => ({
        id: line.id || `pol-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        plantName: line.plantName.trim(),
        containerSize: line.containerSize.trim(),
        quantityOrdered: Math.max(0, Number(line.quantityOrdered) || 0),
        quantityReceived: Math.max(0, Number(line.quantityReceived) || 0),
        unitCost: Math.max(0, Number(line.unitCost) || 0)
      }))
      .filter((line) => line.plantName && line.quantityOrdered > 0);

    if (items.length === 0) {
      setError(t('purchasing.addLineItem'));
      return;
    }

    for (const line of items) {
      if (line.quantityOrdered < line.quantityReceived) {
        setError(t('purchasing.poQtyBelowReceived'));
        return;
      }
    }

    try {
      setError(null);
      await onSave({
        ...order,
        vendorId: vendor.id,
        vendorName: vendor.name,
        expectedDate: expectedDate.trim() || undefined,
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
      aria-label={t('purchasing.editPo')}
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
              {t('purchasing.editPo')}
            </h3>
            <p className="text-[11px] text-slate-300 mt-1 truncate">
              {order.poNumber} · {order.vendorName} · {money(order.grandTotal)}
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
          {hasReceipts && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              {t('purchasing.poEditReceivedHint')}
            </p>
          )}

          <div className="grid sm:grid-cols-2 gap-2">
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('purchasing.vendorLabel')}</span>
              <select
                required
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                disabled={hasReceipts}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:bg-slate-100"
              >
                <option value="">{t('purchasing.selectVendor')}</option>
                {pickerVendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('purchasing.expected')}</span>
              <input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-1.5 px-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">
              <span className="col-span-4">{t('purchasing.plant')}</span>
              <span className="col-span-2">{t('purchasing.size')}</span>
              <span className="col-span-2">{t('common.qty')}</span>
              <span className="col-span-3">{t('purchasing.unitPrice')}</span>
              <span className="col-span-1" />
            </div>
            {lines.map((line, idx) => {
              const received = line.quantityReceived || 0;
              const locked = received > 0;
              return (
                <div key={line.id || idx} className="grid grid-cols-12 gap-1.5">
                  <input
                    value={line.plantName}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, plantName: e.target.value };
                      setLines(next);
                    }}
                    placeholder={t('purchasing.plant')}
                    disabled={locked}
                    className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs disabled:bg-slate-100"
                  />
                  <input
                    value={line.containerSize}
                    onChange={(e) => {
                      const next = [...lines];
                      next[idx] = { ...line, containerSize: e.target.value };
                      setLines(next);
                    }}
                    placeholder={t('purchasing.size')}
                    disabled={locked}
                    className="col-span-2 px-2 py-1.5 border border-gray-200 rounded-lg text-xs disabled:bg-slate-100"
                  />
                  <div className="col-span-2">
                    <input
                      type="number"
                      min={received || 1}
                      value={line.quantityOrdered || ''}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = {
                          ...line,
                          quantityOrdered: Number(e.target.value) || 0
                        };
                        setLines(next);
                      }}
                      placeholder={t('common.qty')}
                      className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    {received > 0 && (
                      <p className="text-[9px] text-slate-500 mt-0.5">
                        {t('purchasing.receivedShort', { n: received })}
                      </p>
                    )}
                  </div>
                  <div className="col-span-3 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold text-slate-400 pointer-events-none">
                      $
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitCost || ''}
                      onChange={(e) => {
                        const next = [...lines];
                        next[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                        setLines(next);
                      }}
                      placeholder={t('purchasing.unitPricePlaceholder')}
                      aria-label={t('purchasing.unitPrice')}
                      className="w-full pl-5 pr-2 py-1.5 border border-gray-200 rounded-lg text-xs font-mono"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                    className="col-span-1 text-rose-600 flex items-center justify-center disabled:opacity-30"
                    disabled={lines.length === 1 || locked}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setLines([...lines, emptyFormLine()])}
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
            {busy ? t('common.pleaseWait') : t('purchasing.savePo')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
