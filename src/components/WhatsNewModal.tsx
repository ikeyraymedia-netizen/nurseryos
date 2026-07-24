import { Bell, CheckSquare, ClipboardList, DollarSign, FileText, Sprout, Truck as TruckIcon, X } from 'lucide-react';
import { WhatsNewItem, WhatsNewKind } from '../lib/whatsNew';

interface WhatsNewModalProps {
  items: WhatsNewItem[];
  onDismiss: () => void;
  onOpenTasks?: () => void;
  onOpenOrders?: () => void;
  onOpenTrucks?: () => void;
  onOpenCustomers?: () => void;
}

function kindIcon(kind: WhatsNewKind) {
  switch (kind) {
    case 'order':
      return FileText;
    case 'truck':
      return TruckIcon;
    case 'task':
      return ClipboardList;
    case 'plant':
      return Sprout;
    case 'payment':
      return DollarSign;
    default:
      return Bell;
  }
}

function kindLabel(kind: WhatsNewKind) {
  switch (kind) {
    case 'order':
      return 'Order';
    case 'truck':
      return 'Truck';
    case 'task':
      return 'Task';
    case 'plant':
      return 'Plant';
    case 'payment':
      return 'Payment';
    default:
      return 'Update';
  }
}

export function WhatsNewModal({
  items,
  onDismiss,
  onOpenTasks,
  onOpenOrders,
  onOpenTrucks,
  onOpenCustomers
}: WhatsNewModalProps) {
  if (items.length === 0) return null;

  const counts = {
    order: items.filter((i) => i.kind === 'order').length,
    truck: items.filter((i) => i.kind === 'truck').length,
    task: items.filter((i) => i.kind === 'task').length,
    plant: items.filter((i) => i.kind === 'plant').length,
    payment: items.filter((i) => i.kind === 'payment').length
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 bg-slate-900 text-white">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Bell className="h-5 w-5 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h3 className="font-black text-base tracking-tight">Since you were last here</h3>
              <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                {[
                  counts.payment
                    ? `${counts.payment} payment${counts.payment === 1 ? '' : 's'}`
                    : null,
                  counts.order ? `${counts.order} new order${counts.order === 1 ? '' : 's'}` : null,
                  counts.truck ? `${counts.truck} truck${counts.truck === 1 ? '' : 's'}` : null,
                  counts.task ? `${counts.task} task${counts.task === 1 ? '' : 's'}` : null,
                  counts.plant ? `${counts.plant} plant add${counts.plant === 1 ? '' : 's'}` : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto divide-y divide-slate-100">
          {items.map((item) => {
            const Icon = kindIcon(item.kind);
            return (
              <div key={item.id} className="px-5 py-3 flex items-start gap-3">
                <div className="h-8 w-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon className="h-4 w-4 text-emerald-800" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {kindLabel(item.kind)}
                    </span>
                    {item.mine && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-800 bg-emerald-50 border border-emerald-100 rounded px-1.5 py-0.5">
                        Assigned to you
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-bold text-gray-900 leading-snug">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.detail}</p>
                  <p className="text-[10px] text-slate-400 mt-1 font-mono">
                    {new Date(item.at).toLocaleString()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex flex-wrap gap-2 justify-between bg-slate-50/80">
          <div className="flex flex-wrap gap-2">
            {counts.payment > 0 && onOpenCustomers && (
              <button
                type="button"
                onClick={() => {
                  onOpenCustomers();
                  onDismiss();
                }}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
              >
                View customers
              </button>
            )}
            {counts.order > 0 && onOpenOrders && (
              <button
                type="button"
                onClick={() => {
                  onOpenOrders();
                  onDismiss();
                }}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              >
                View orders
              </button>
            )}
            {counts.truck > 0 && onOpenTrucks && (
              <button
                type="button"
                onClick={() => {
                  onOpenTrucks();
                  onDismiss();
                }}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              >
                View trucks
              </button>
            )}
            {counts.task > 0 && onOpenTasks && (
              <button
                type="button"
                onClick={() => {
                  onOpenTasks();
                  onDismiss();
                }}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              >
                View tasks
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-emerald-700 text-white hover:bg-emerald-800"
          >
            <CheckSquare className="h-3.5 w-3.5" />
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
