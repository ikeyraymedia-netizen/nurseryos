/** Cash already recorded on a vendor bill. A paid bill with no stored amount used its total. */
export function billAmountPaid(bill: {
  status?: string;
  amountPaid?: number;
  grandTotal?: number;
}): number {
  if (typeof bill.amountPaid === 'number' && Number.isFinite(bill.amountPaid)) {
    return bill.amountPaid;
  }
  if (bill.status === 'paid') return Number(bill.grandTotal) || 0;
  return 0;
}

/** What is still owed on a vendor bill. */
export function billBalanceDue(bill: {
  status?: string;
  amountPaid?: number;
  grandTotal?: number;
}): number {
  return Math.max(0, Number(((Number(bill.grandTotal) || 0) - billAmountPaid(bill)).toFixed(2)));
}

/** Apply one manual payment on top of cash already recorded. Amounts are dollars. */
export function applyManualInvoicePayment(
  grandTotal: number,
  alreadyPaid: number,
  amount: number
): {
  paymentStatus: 'paid' | 'unpaid';
  stripePaidAmountCents: number;
  overpaidAmount: number;
  amountReceived: number;
} {
  const totalCents = Math.round((Number(grandTotal) || 0) * 100);
  const prevCents = Math.round((Number(alreadyPaid) || 0) * 100);
  const received = Math.round(Math.max(0, Number(amount) || 0) * 100) / 100;
  const cumulativeCents = prevCents + Math.round(received * 100);
  const over = (cumulativeCents - totalCents) / 100;
  return {
    paymentStatus: cumulativeCents >= totalCents ? 'paid' : 'unpaid',
    stripePaidAmountCents: cumulativeCents,
    overpaidAmount: over > 0.009 ? Number(over.toFixed(2)) : 0,
    amountReceived: received
  };
}
