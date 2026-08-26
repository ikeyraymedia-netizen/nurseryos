/** True when an order number is worth showing (not blank / N/A placeholders). */
export function meaningfulOrderNumber(orderNumber?: string | null): string | null {
  const n = String(orderNumber || '').trim();
  if (!n || /^n\/?a$/i.test(n) || n === '—' || n === '-') return null;
  return n;
}

/** Prefer a real customer PO over a blank/placeholder order number for labels. */
export function orderRefLabel(order: {
  orderNumber?: string | null;
  invoiceDetails?: { poNumber?: string | null } | null;
}): string | null {
  const po = String(order.invoiceDetails?.poNumber || '').trim();
  if (po && !/^n\/?a$/i.test(po)) return `PO ${po}`;
  return meaningfulOrderNumber(order.orderNumber);
}
