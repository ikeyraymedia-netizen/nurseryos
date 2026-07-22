/**
 * Deliver a PDF without navigating away from the SPA.
 *
 * iOS Safari often blocks popups after async PDF generation. An earlier
 * fallback (`window.location.assign(blobUrl)`) replaced the entire app with a
 * blank/white screen. Desktop still gets a normal file download; phones get an
 * in-app preview sheet with Share / Save instead.
 */

export type PdfDelivery =
  | { method: 'download' }
  | {
      method: 'preview';
      url: string;
      fileName: string;
      blob: Blob;
    };

function safePdfFileName(fileName: string): string {
  return (fileName || 'document.pdf').replace(/[^\w.\-]+/g, '_');
}

function asPdfBlob(blob: Blob): Blob {
  return blob.type === 'application/pdf'
    ? blob
    : new Blob([blob], { type: 'application/pdf' });
}

/** True for phones / iPads where blob downloads and popups are unreliable. */
export function needsInAppPdfPreview(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const appleTouch =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (appleTouch) return true;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const narrow =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 900px)').matches;
  return Boolean(coarse && narrow);
}

/**
 * Desktop → trigger a file download.
 * Mobile → return a preview payload the caller must show in-app.
 * Never calls location.assign / location.href.
 */
export async function deliverPdfBlob(
  blob: Blob,
  fileName: string
): Promise<PdfDelivery> {
  const safeName = safePdfFileName(fileName);
  const pdfBlob = asPdfBlob(blob);

  if (needsInAppPdfPreview()) {
    const url = URL.createObjectURL(pdfBlob);
    return { method: 'preview', url, fileName: safeName, blob: pdfBlob };
  }

  const url = URL.createObjectURL(pdfBlob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = safeName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { method: 'download' };
}

/** @deprecated Prefer deliverPdfBlob so callers can show the mobile preview sheet. */
export async function downloadPdfBlob(blob: Blob, fileName: string): Promise<void> {
  const result = await deliverPdfBlob(blob, fileName);
  if (result.method === 'preview') {
    setTimeout(() => URL.revokeObjectURL(result.url), 60_000);
  }
}
