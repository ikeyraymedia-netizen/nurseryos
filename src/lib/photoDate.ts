/** Photos older than this many months are flagged for a refresh. */
export const PHOTO_STALE_MONTHS = 6;

function parsePhotoDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** e.g. "3/2/2026" */
export function formatPhotoDate(iso?: string | null): string {
  const d = parsePhotoDate(iso);
  return d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : '';
}

/** Compact label for small thumbnails, e.g. "3/26". */
export function formatPhotoDateShort(iso?: string | null): string {
  const d = parsePhotoDate(iso);
  return d ? `${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}` : '';
}

export function photoAgeMonths(iso?: string | null, now = new Date()): number | null {
  const d = parsePhotoDate(iso);
  if (!d) return null;
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

export function isPhotoStale(iso?: string | null): boolean {
  const months = photoAgeMonths(iso);
  return months != null && months >= PHOTO_STALE_MONTHS;
}
