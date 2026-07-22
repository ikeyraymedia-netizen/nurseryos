import React, { useEffect } from 'react';
import { Share2, X, Download } from 'lucide-react';

interface PdfShareSheetProps {
  url: string;
  fileName: string;
  blob: Blob;
  title?: string;
  onClose: () => void;
}

/**
 * In-app PDF ready sheet for mobile. Avoids navigating the SPA to a blob URL
 * (which blanks the screen on iOS when popups are blocked).
 */
export const PdfShareSheet: React.FC<PdfShareSheetProps> = ({
  url,
  fileName,
  blob,
  title = 'PDF ready',
  onClose
}) => {
  useEffect(() => {
    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };
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

    // User-initiated open — more likely to be allowed than a programmatic one
    // after async PDF generation.
    const opened = window.open(url, '_blank');
    if (!opened) {
      alert(
        'Could not open the PDF automatically. Use the Download link below, or take a screenshot of the preview.'
      );
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-slate-950/80 backdrop-blur-sm flex flex-col p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-auto flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-900 truncate">{title}</h3>
            <p className="text-[10px] text-slate-500 truncate">{fileName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-200 text-slate-500"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 bg-slate-100">
          <iframe
            title={fileName}
            src={url}
            className="w-full h-full border-0 bg-white"
          />
        </div>

        <div className="p-3 sm:p-4 border-t border-slate-200 flex flex-col sm:flex-row gap-2 bg-white">
          <button
            type="button"
            onClick={handleShare}
            className="flex-1 py-3 px-4 bg-emerald-800 hover:bg-emerald-900 text-white rounded-xl text-xs font-black flex items-center justify-center gap-2"
          >
            <Share2 className="h-4 w-4" />
            Share / Save PDF
          </button>
          <a
            href={url}
            download={fileName}
            className="flex-1 py-3 px-4 bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 rounded-xl text-xs font-black flex items-center justify-center gap-2"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            className="sm:w-28 py-3 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
