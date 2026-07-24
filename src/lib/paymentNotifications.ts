import { CustomerDocument } from '../types';

export interface PaymentNotice {
  id: string;
  documentNumber: string;
  customerName: string;
  amount: number;
  paidAt: string;
}

function storageKey(tenantId: string, userId: string) {
  return `nurseryos:lastSeenPayments:${tenantId}:${userId}`;
}

export function getLastSeenPaymentAt(tenantId: string, userId: string): string | null {
  try {
    return localStorage.getItem(storageKey(tenantId, userId));
  } catch {
    return null;
  }
}

export function setLastSeenPaymentAt(
  tenantId: string,
  userId: string,
  iso = new Date().toISOString()
) {
  try {
    localStorage.setItem(storageKey(tenantId, userId), iso);
  } catch {
    // ignore quota / private mode
  }
}

export function paidInvoicesSince(
  documents: CustomerDocument[],
  sinceIso: string
): PaymentNotice[] {
  return documents
    .filter(
      (d) =>
        d.type === 'invoice' &&
        d.paymentStatus === 'paid' &&
        typeof d.paidAt === 'string' &&
        d.paidAt > sinceIso
    )
    .map((d) => ({
      id: d.id,
      documentNumber: d.documentNumber || d.id,
      customerName: d.billToName || d.customerName || 'Customer',
      amount:
        typeof d.stripePaidAmountCents === 'number'
          ? d.stripePaidAmountCents / 100
          : d.grandTotal,
      paidAt: d.paidAt!
    }))
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
}
