/** Local calendar helpers (YYYY-MM-DD). */

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as a local calendar date (avoids UTC off-by-one). */
export function parseDateKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * Compute a due date from invoice/bill date + payment terms text.
 * Supports Net/NET 10–90, Due on Receipt, COD, and loose variants like "30 days".
 * Returns null if terms are unknown.
 */
export function dueDateFromPaymentTerms(
  billDateKey: string,
  paymentTerms?: string | null
): string | null {
  const base = parseDateKey(billDateKey);
  if (!base) return null;

  const raw = String(paymentTerms || '').trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (
    normalized === 'due on receipt' ||
    normalized === 'upon receipt' ||
    normalized === 'cod' ||
    normalized === 'cod (pickup)' ||
    normalized === 'pre-pay' ||
    normalized === 'prepay' ||
    normalized === 'pre pay' ||
    normalized.includes('due on receipt') ||
    normalized.includes('upon receipt') ||
    normalized === 'cash' ||
    normalized === 'cash on delivery'
  ) {
    return billDateKey;
  }

  const netMatch =
    normalized.match(/\bnet\s*[-:]?\s*(\d{1,3})\b/) ||
    normalized.match(/\b(\d{1,3})\s*(?:day|days|net)\b/);
  if (netMatch) {
    const days = Number(netMatch[1]);
    if (!Number.isFinite(days) || days < 0 || days > 365) return null;
    base.setDate(base.getDate() + days);
    return toDateKey(base);
  }

  // Bare number only (e.g. "30")
  if (/^\d{1,3}$/.test(normalized)) {
    const days = Number(normalized);
    if (days > 0 && days <= 365) {
      base.setDate(base.getDate() + days);
      return toDateKey(base);
    }
  }

  return null;
}

/** Sunday (local) as YYYY-MM-DD for the week containing `date`. */
export function startOfWeekSunday(date = new Date()): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  return toDateKey(d);
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

export function weekDateKeysFromSunday(weekStartSunday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(weekStartSunday, i));
}

export function formatDayChipLabel(dateKey: string): { weekday: string; monthDay: string } {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    monthDay: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  };
}
