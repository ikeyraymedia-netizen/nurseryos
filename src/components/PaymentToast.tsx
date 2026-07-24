import { CheckCircle2, DollarSign, X } from 'lucide-react';
import { PaymentNotice } from '../lib/paymentNotifications';

interface PaymentToastProps {
  notices: PaymentNotice[];
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}

export function PaymentToast({ notices, onDismiss, onDismissAll }: PaymentToastProps) {
  if (notices.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[70] w-[min(100vw-2rem,22rem)] space-y-2 pointer-events-none">
      {notices.slice(0, 4).map((notice) => (
        <div
          key={notice.id}
          className="pointer-events-auto rounded-2xl border border-emerald-200 bg-white shadow-xl shadow-emerald-900/10 overflow-hidden animate-[slideIn_0.25s_ease-out]"
        >
          <div className="px-3.5 py-3 flex items-start gap-3">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
              <DollarSign className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                <p className="text-xs font-black uppercase tracking-wide text-emerald-800">
                  Invoice paid
                </p>
              </div>
              <p className="text-sm font-bold text-gray-900 mt-0.5 truncate">
                {notice.documentNumber} · {notice.customerName}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                ${notice.amount.toFixed(2)} received
                {notice.paidAt
                  ? ` · ${new Date(notice.paidAt).toLocaleString(undefined, {
                      dateStyle: 'short',
                      timeStyle: 'short'
                    })}`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(notice.id)}
              className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
      {notices.length > 1 && (
        <button
          type="button"
          onClick={onDismissAll}
          className="pointer-events-auto w-full text-[11px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-xl py-1.5 hover:bg-emerald-100"
        >
          Dismiss all ({notices.length})
        </button>
      )}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
