import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, Split, Check } from 'lucide-react';
import { Customer, CustomerOrder, PlantOrderItem } from '../types';
import { getDefaultPriceForSize } from '../lib/pricing';
import { addCustomerDocument, listAllDocuments, nextDocumentNumber } from '../lib/documents';
import { updateCustomerOrder } from '../lib/db';
import {
  bumpInvoicedQuantities,
  itemRemainingInvoiceQty,
  orderItemsRemainingForInvoice,
  invoicesForOrder
} from '../lib/invoicing';
import { logAuditEvent } from '../lib/audit';
import { dueDateFromPaymentTerms } from '../lib/dates';
import { useT } from '../lib/i18n';

interface SplitInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: CustomerOrder;
  customer: Customer | null;
  nurseryName?: string;
  tenantId?: string;
  onSaved?: (documentId: string) => void;
}

export const SplitInvoiceModal: React.FC<SplitInvoiceModalProps> = ({
  isOpen,
  onClose,
  order,
  customer,
  nurseryName = 'NurseryOS',
  tenantId,
  onSaved
}) => {
  const t = useT();
  const [splitQty, setSplitQty] = useState<Record<string, number>>({});
  const [itemPrices, setItemPrices] = useState<Record<string, number>>({});
  const [freightCharge, setFreightCharge] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [existingCount, setExistingCount] = useState(0);

  const remainingItems = useMemo(() => orderItemsRemainingForInvoice(order), [order]);

  useEffect(() => {
    if (!isOpen) return;
    const nextQty: Record<string, number> = {};
    const nextPrices: Record<string, number> = {};
    for (const item of remainingItems) {
      nextQty[item.id] = 0;
      nextPrices[item.id] =
        item.unitPrice !== undefined ? item.unitPrice : getDefaultPriceForSize(item.containerSize);
    }
    setSplitQty(nextQty);
    setItemPrices(nextPrices);
    setFreightCharge(0);
    setDiscount(0);
    setTaxRate(order.invoiceDetails?.taxRate ?? 0);
    setPaymentTerms(order.invoiceDetails?.paymentTerms || customer?.paymentTerms || 'Net 30');
    setPoNumber(order.invoiceDetails?.poNumber || '');
    setInvoiceNotes('');
    setInvoiceDate(new Date().toISOString().split('T')[0]);
    setSaveSuccess(false);
    void listAllDocuments().then((docs) => {
      setExistingCount(invoicesForOrder(order.id, docs).length);
    });
  }, [isOpen, order, remainingItems, customer]);

  useEffect(() => {
    if (!invoiceDate) return;
    const next = dueDateFromPaymentTerms(invoiceDate, paymentTerms);
    if (next) setDueDate(next);
  }, [invoiceDate, paymentTerms]);

  const selectedLines = useMemo(() => {
    return remainingItems
      .map((item) => ({
        item,
        qty: Math.min(item.quantity, Math.max(0, splitQty[item.id] ?? 0))
      }))
      .filter((row) => row.qty > 0);
  }, [remainingItems, splitQty]);

  const subtotal = selectedLines.reduce((sum, row) => {
    const price = itemPrices[row.item.id] ?? 0;
    return sum + row.qty * price;
  }, 0);
  const salesTax = subtotal * (taxRate / 100);
  const grandTotal = subtotal - discount + salesTax + freightCharge;

  function setLineQty(itemId: string, qty: number, max: number) {
    const next = Math.max(0, Math.min(max, qty));
    setSplitQty((prev) => ({ ...prev, [itemId]: next }));
  }

  function fillAllRemaining() {
    const next: Record<string, number> = {};
    for (const item of remainingItems) {
      next[item.id] = item.quantity;
    }
    setSplitQty(next);
  }

  async function handleSave() {
    if (selectedLines.length === 0) return;
    const customerId = customer?.id || order.customerId;
    if (!customerId) {
      alert(t('invoice.noCustomerLinked'));
      return;
    }

    setBusy(true);
    setSaveSuccess(false);
    try {
      const invoiceNumber = await nextDocumentNumber('invoice', {
        considerQuickbooks: Boolean(tenantId),
        tenantId
      });
      const billToName = customer?.billingName || customer?.name || order.customerName;
      const billToAddress = customer?.billingAddress || '';

      const lineItems = selectedLines.map(({ item, qty }) => ({
        id: item.id,
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: qty,
        unitPrice: itemPrices[item.id] ?? 0,
        unitCost: item.unitCost,
        notes: item.notes,
        vendor: item.vendor
      }));

      const splitNote =
        existingCount > 0
          ? t('invoice.splitNoteContinuing', { order: order.orderNumber, n: existingCount + 1 })
          : t('invoice.splitNoteFirst', { order: order.orderNumber });

      const documentId = await addCustomerDocument({
        customerId,
        customerName: billToName,
        orderId: order.id,
        orderNumber: order.orderNumber,
        type: 'invoice',
        documentNumber: invoiceNumber,
        documentDate: invoiceDate,
        dueDate: dueDate || undefined,
        poNumber: poNumber.trim() || undefined,
        paymentTerms,
        taxRate,
        freightCharge,
        discount,
        notes: invoiceNotes.trim() ? `${splitNote}\n${invoiceNotes.trim()}` : splitNote,
        billToName,
        billToAddress: billToAddress || undefined,
        customerEmail: order.customerEmail || customer?.contactEmail,
        customerEmailCc: order.customerEmailCc || customer?.contactEmailCc,
        owner: order.owner,
        items: lineItems,
        subtotal,
        salesTax,
        grandTotal
      });

      const invoicedBump = selectedLines.map(({ item, qty }) => ({
        id: item.id,
        quantity: qty
      }));
      const pricedItems = order.items.map((item) => {
        const price = itemPrices[item.id];
        if (price === undefined) return item;
        return { ...item, unitPrice: price };
      });
      const updatedItems = bumpInvoicedQuantities(pricedItems, invoicedBump);

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        customerId,
        invoiceDetails: {
          ...order.invoiceDetails,
          taxRate,
          paymentTerms,
          poNumber: poNumber.trim() || order.invoiceDetails?.poNumber
        }
      });

      await logAuditEvent({
        action: 'invoice.split_saved',
        summary: `Split invoice ${invoiceNumber} for ${billToName} (${selectedLines.length} lines)`,
        meta: {
          documentId,
          orderId: order.id,
          grandTotal,
          lineCount: selectedLines.length
        }
      });

      setSaveSuccess(true);
      onSaved?.(documentId);
      window.setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : t('invoice.splitSaveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[85] bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[92vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-150">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
              <Split className="h-4 w-4 text-ink-700" />
              {t('invoice.splitTitle')}
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
              {t('invoice.splitHint', { customer: order.customerName, order: order.orderNumber })}
            </p>
            {existingCount > 0 && (
              <p className="text-[11px] font-semibold text-sky-800 mt-1">
                {t('invoice.splitExisting', { n: existingCount })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-800 hover:bg-gray-100 shrink-0"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {remainingItems.length === 0 ? (
          <div className="p-6 text-sm text-gray-600">{t('invoice.splitNothingLeft')}</div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={fillAllRemaining}
                className="text-[11px] font-bold text-ink-800 hover:text-ink-950 underline"
              >
                {t('invoice.splitSelectAllRemaining')}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {remainingItems.map((item) => {
                const remaining = itemRemainingInvoiceQty(item);
                const ordered = order.items.find((o) => o.id === item.id)?.quantity ?? item.quantity;
                const already = ordered - remaining;
                const thisQty = splitQty[item.id] ?? 0;
                return (
                  <div
                    key={item.id}
                    className="rounded-xl border border-gray-150 px-3 py-2.5 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 sm:gap-3 items-center"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">{item.plantName}</p>
                      <p className="text-[11px] text-gray-500">
                        {item.containerSize} · {t('invoice.splitOrdered', { n: ordered })}
                        {already > 0 ? ` · ${t('invoice.splitAlreadyInvoiced', { n: already })}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-gray-400 uppercase">{t('common.qty')}</span>
                      <button
                        type="button"
                        onClick={() => setLineQty(item.id, thisQty - 1, remaining)}
                        className="h-7 w-7 rounded-lg border border-gray-200 text-gray-700 font-bold"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={remaining}
                        value={thisQty}
                        onChange={(e) =>
                          setLineQty(item.id, Number(e.target.value) || 0, remaining)
                        }
                        className="w-14 text-center text-sm font-mono border border-gray-200 rounded-lg py-1"
                      />
                      <button
                        type="button"
                        onClick={() => setLineQty(item.id, thisQty + 1, remaining)}
                        className="h-7 w-7 rounded-lg border border-gray-200 text-gray-700 font-bold"
                      >
                        +
                      </button>
                      <span className="text-[11px] text-gray-400">/ {remaining}</span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:justify-end">
                      <span className="text-[10px] font-bold text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={itemPrices[item.id] ?? 0}
                        onChange={(e) =>
                          setItemPrices((prev) => ({
                            ...prev,
                            [item.id]: Number(e.target.value) || 0
                          }))
                        }
                        className="w-24 text-right text-sm font-mono border border-gray-200 rounded-lg py-1 px-2"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-4 py-3 border-t border-gray-100 grid sm:grid-cols-3 gap-3">
              <label className="text-xs space-y-1">
                <span className="font-bold text-gray-500">{t('invoice.freightLabel')}</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={freightCharge || ''}
                  onChange={(e) => setFreightCharge(Number(e.target.value) || 0)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-mono"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="font-bold text-gray-500">{t('invoice.salesTax')} %</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={taxRate || ''}
                  onChange={(e) => setTaxRate(Number(e.target.value) || 0)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-mono"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="font-bold text-gray-500">{t('invoice.discount')}</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={discount || ''}
                  onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-mono"
                />
              </label>
            </div>

            <div className="px-4 pb-1 flex justify-between text-sm font-bold text-gray-800">
              <span>{t('invoice.balanceDue')}</span>
              <span className="font-mono">${grandTotal.toFixed(2)}</span>
            </div>

            <div className="px-4 pb-4">
              <button
                type="button"
                disabled={busy || selectedLines.length === 0}
                onClick={() => void handleSave()}
                className={`w-full py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 ${
                  saveSuccess
                    ? 'bg-ink-600 text-white'
                    : 'bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50'
                }`}
              >
                {saveSuccess ? (
                  <>
                    <Check className="h-4 w-4" />
                    {t('invoice.savedToCustomer')}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    {busy ? t('invoice.saving') : t('invoice.splitSave', { nurseryName })}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
