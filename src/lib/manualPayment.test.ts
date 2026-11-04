import assert from 'node:assert/strict';
import test from 'node:test';
import { applyManualInvoicePayment, billAmountPaid, billBalanceDue } from './manualPayment.ts';

test('a short payment leaves the invoice open', () => {
  const applied = applyManualInvoicePayment(100, 0, 40);
  assert.equal(applied.paymentStatus, 'unpaid');
  assert.equal(applied.stripePaidAmountCents, 4000);
  assert.equal(applied.overpaidAmount, 0);
  assert.equal(applied.amountReceived, 40);
});

test('the exact balance marks the invoice paid', () => {
  const applied = applyManualInvoicePayment(100, 0, 100);
  assert.equal(applied.paymentStatus, 'paid');
  assert.equal(applied.stripePaidAmountCents, 10000);
  assert.equal(applied.overpaidAmount, 0);
});

test('an extra payment is kept as overpaid', () => {
  const applied = applyManualInvoicePayment(100, 0, 125.5);
  assert.equal(applied.paymentStatus, 'paid');
  assert.equal(applied.stripePaidAmountCents, 12550);
  assert.equal(applied.overpaidAmount, 25.5);
});

test('a short vendor payment leaves the rest of the bill open', () => {
  const bill = { status: 'unpaid', grandTotal: 500, amountPaid: 200 };
  assert.equal(billAmountPaid(bill), 200);
  assert.equal(billBalanceDue(bill), 300);
});

test('a paid vendor bill with no stored amount counts as paid in full', () => {
  const bill = { status: 'paid', grandTotal: 80 };
  assert.equal(billAmountPaid(bill), 80);
  assert.equal(billBalanceDue(bill), 0);
});

test('a later payment adds to cash already recorded', () => {
  const applied = applyManualInvoicePayment(100, 40, 60);
  assert.equal(applied.paymentStatus, 'paid');
  assert.equal(applied.stripePaidAmountCents, 10000);
  assert.equal(applied.overpaidAmount, 0);
});
