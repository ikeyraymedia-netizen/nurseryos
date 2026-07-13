/** Local calendar helpers (YYYY-MM-DD). */

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
