import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Share2, X, Download } from 'lucide-react';
import { useT } from '../lib/i18n';
import { needsInAppPdfPreview } from '../lib/downloadPdf';

interface PdfShareSheetProps {
  url: string;
  fileName: string;
  blob: Blob;
  title?: string;
  onClose: () => void;
}

/**
 * In-app PDF ready sheet for mobile. Portaled to document.body so iOS Safari
 * cannot trap `position:fixed` inside a scrolling modal (which looks like
 * "nothing happened" after Generate / Download).
 */
export const PdfShareSheet: React.FC<PdfShareSheetProps> = ({
  url,
  fileName,
  blob,
  title,
  onClose
}) => {
  const t = useT();
  const sheetTitle = title ?? t('pdfShare.title');
  const hideUnreliablePreview = needsInAppPdfPreview();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }, 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [url]);

  const handleShare = async () => {
    try {
      const file = new File([blob], fileName, { type: 'application/pdf' });
      if (
        typeof navigator.share === 'function' &&
        (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }))
      ) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
    }

    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      alert(t('pdfShare.openFailed'));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[500] bg-slate-950/85 backdrop-blur-sm flex flex-col p-3 sm:p-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-auto flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-900 truncate">{sheetTitle}</h3>
            <p className="text-[10px] text-slate-500 truncate">{fileName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-200 text-slate-500"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-3 sm:p-4 border-b border-slate-200 flex flex-col gap-2 bg-white">
          {hideUnreliablePreview && (
            <p className="text-[11px] text-slate-600 leading-snug">{t('pdfShare.phoneHint')}</p>
          )}
          <button
            type="button"
            onClick={() => void handleShare()}
            className="w-full py-3.5 px-4 bg-ink-800 hover:bg-ink-900 text-white rounded-xl text-xs font-black flex items-center justify-center gap-2"
          >
            <Share2 className="h-4 w-4" />
            {t('pdfShare.share')} / {t('pdfShare.savePdf')}
          </button>
          <div className="flex gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-3 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 rounded-xl text-xs font-black flex items-center justify-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              {t('pdfShare.openPdf')}
            </a>
            <a
              href={url}
              download={fileName}
              className="flex-1 py-3 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 rounded-xl text-xs font-black flex items-center justify-center gap-2"
            >
              <Download className="h-4 w-4" />
              {t('pdfShare.download')}
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold"
          >
            {t('pdfShare.done')}
          </button>
        </div>

        {!hideUnreliablePreview && (
          <div className="flex-1 min-h-0 bg-slate-100">
            <iframe
              title={fileName}
              src={url}
              className="w-full h-full border-0 bg-white"
            />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
