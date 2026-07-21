const ORDER_UPLOAD_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain'
]);

/** Normalize browser quirks (empty type, image/jpg, application/x-pdf). */
export function inferUploadMimeType(
  fileName: string,
  fileType?: string | null,
  orderText?: string
): string {
  const raw = String(fileType || '')
    .trim()
    .toLowerCase();

  if (raw === 'application/pdf' || raw === 'application/x-pdf' || raw === 'application/acrobat') {
    return 'application/pdf';
  }
  if (raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg';
  if (raw === 'image/jpeg' || raw === 'image/png' || raw === 'image/webp' || raw === 'text/plain') {
    return raw;
  }

  if (orderText) return 'text/plain';

  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.txt')) return 'text/plain';

  return raw;
}

export function isAllowedOrderUploadMime(mime: string): boolean {
  return ORDER_UPLOAD_MIMES.has(mime);
}
