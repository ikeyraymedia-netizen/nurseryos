import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useT } from '../lib/i18n';

/** Covers the screen while a save or email is in progress so the window is not closed early. */
export function QuickbooksSavingShield({ open, title }: { open: boolean; title?: string }) {
  const t = useT();
  const label = title || t('invoice.qbSavingTitle');
  const dialogRef = useRef<HTMLDialogElement>(null);

  // A normal overlay loses to the invoice window's blur layer. showModal() uses the
  // browser top layer, so the spinner stays in front for the whole save or send.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

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
    <dialog
      ref={dialogRef}
      aria-busy="true"
      aria-live="assertive"
      aria-label={label}
      onCancel={(event) => event.preventDefault()}
      className="m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-transparent p-0"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0,
        padding: 0,
        border: 'none',
        background: 'rgba(15, 23, 42, 0.6)'
      }}
    >
      <div className="mx-4 w-full max-w-sm rounded-2xl bg-white px-6 py-6 text-center shadow-2xl">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-sky-700" />
        <p className="mt-3 text-sm font-black text-slate-900">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t('invoice.qbSavingHint')}</p>
      </div>
    </dialog>,
    document.body
  );
}
