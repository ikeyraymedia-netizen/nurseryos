/**
 * Save / share a PDF blob in a way that works on desktop and mobile.
 *
 * iOS Safari (and many in-app browsers) ignore `<a download>` for blob URLs,
 * so a programmatic click silently does nothing. Prefer the native share sheet
 * when available; otherwise open the PDF in a new tab so the user can Save/Share
 * from the browser's PDF viewer.
 */
export async function downloadPdfBlob(blob: Blob, fileName: string): Promise<void> {
  const safeName = (fileName || 'document.pdf').replace(/[^\w.\-]+/g, '_');
  const pdfBlob =
    blob.type === 'application/pdf'
      ? blob
      : new Blob([blob], { type: 'application/pdf' });

  // iOS / Android: Web Share with a File is the most reliable path.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      const file = new File([pdfBlob], safeName, { type: 'application/pdf' });
      const canShareFiles =
        typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
      if (canShareFiles) {
        await navigator.share({
          files: [file],
          title: safeName
        });
        return;
      }
    } catch (err: any) {
      // User dismissed the share sheet — treat as success (don't also open a tab).
      if (err?.name === 'AbortError') return;
      // Fall through to link / new-tab download.
    }
  }

  const url = URL.createObjectURL(pdfBlob);
  const isAppleTouch =
    typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  try {
    if (isAppleTouch) {
      // download= is unreliable on iOS — open the PDF so Safari's viewer can save it.
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        // Popup blocked (common in embedded webviews): navigate this tab.
        window.location.assign(url);
      }
      return;
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = safeName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    // Keep the blob URL alive long enough for the new tab / download to start.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
