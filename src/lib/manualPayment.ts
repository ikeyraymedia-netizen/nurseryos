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
