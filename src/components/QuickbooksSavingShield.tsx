import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useT } from '../lib/i18n';

/** Covers the screen while a save is in progress so the window is not closed early. */
export function QuickbooksSavingShield({ open, title }: { open: boolean; title?: string }) {
  const t = useT();
  const label = title || t('invoice.qbSavingTitle');

  useEffect(() => {
    if (!open) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-900/60"
      style={{ zIndex: 200 }}
      role="alertdialog"
      aria-busy="true"
      aria-live="assertive"
      aria-label={label}
    >
      <div className="mx-4 w-full max-w-sm rounded-2xl bg-white px-6 py-6 text-center shadow-2xl">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-sky-700" />
        <p className="mt-3 text-sm font-black text-slate-900">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('invoice.qbSavingHint')}</p>
      </div>
    </div>,
    document.body
  );
}
