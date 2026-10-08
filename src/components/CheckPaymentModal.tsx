import { useEffect, useMemo } from 'react';
import { Receipt, X } from 'lucide-react';
import { VendorBill } from '../types';
import { useT } from '../lib/i18n';
import { formatPaymentRecord } from './MarkPaidModal';

const money = (n: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Bills paid together share the same method + reference (e.g. check number). */
export function billsInSamePayment(bill: VendorBill, bills: VendorBill[]): VendorBill[] {
  const ref = (bill.paymentReference || '').trim().toLowerCase();
  if (!ref) return [bill];
  return bills
    .filter(
      (b) =>
        b.status === 'paid' &&
        b.paymentMethod === bill.paymentMethod &&
        (b.paymentReference || '').trim().toLowerCase() === ref
    )
    .sort(
      (a, b) =>
        (a.billDate || '').localeCompare(b.billDate || '') || a.billNumber.localeCompare(b.billNumber)
    );
}

interface CheckPaymentModalProps {
  bill: VendorBill;
  bills: VendorBill[];
  onClose: () => void;
  onOpenBill?: (bill: VendorBill) => void;
}

export function CheckPaymentModal({ bill, bills, onClose, onOpenBill }: CheckPaymentModalProps) {
  const t = useT();
  const included = useMemo(() => billsInSamePayment(bill, bills), [bill, bills]);
  const total = included.reduce((sum, b) => sum + (b.grandTotal || 0), 0);
  const vendorNames = [...new Set(included.map((b) => b.vendorName).filter(Boolean))];
  const paidDates = [
    ...new Set(
      included.map((b) => (b.paidAt ? new Date(b.paidAt).toLocaleDateString() : '')).filter(Boolean)
    )
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 bg-ink-950 text-white flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-black tracking-tight flex items-center gap-2">
              <Receipt className="h-4 w-4 text-emerald-300 shrink-0" />
              {formatPaymentRecord(t, bill.paymentMethod, bill.paymentReference)}
            </h3>
            <p className="text-[11px] text-slate-300 mt-1">
              {[vendorNames.join(', '), paidDates.join(', ')].filter(Boolean).join(' · ')}
            </p>
            <p className="text-xs font-bold text-emerald-300 mt-1.5">
              {t('purchasing.checkPaymentSummary', { n: included.length, total: money(total) })}
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

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">{t('purchasing.checkPaymentBill')}</th>
                <th className="px-2 py-2 text-left">{t('purchasing.checkPaymentVendorInvoice')}</th>
                <th className="px-2 py-2 text-left">{t('purchasing.checkPaymentBillDate')}</th>
                <th className="px-4 py-2 text-right">{t('purchasing.checkPaymentAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {included.map((b) => (
                <tr
                  key={b.id}
                  onClick={onOpenBill ? () => onOpenBill(b) : undefined}
                  className={`border-t border-slate-100 ${onOpenBill ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                >
                  <td className="px-4 py-2 font-semibold text-slate-900">
                    {b.billNumber}
                    {vendorNames.length > 1 && (
                      <span className="block text-[11px] font-normal text-slate-500">{b.vendorName}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-slate-700">{b.vendorInvoiceNumber || '—'}</td>
                  <td className="px-2 py-2 text-slate-700">{b.billDate || '—'}</td>
                  <td className="px-4 py-2 text-right font-mono">{money(b.grandTotal || 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-bold">
                <td className="px-4 py-2" colSpan={3}>
                  {t('purchasing.checkPaymentTotal')}
                </td>
                <td className="px-4 py-2 text-right font-mono">{money(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
