import assert from 'node:assert/strict';
import test from 'node:test';
import { applyManualInvoicePayment } from './manualPayment.ts';

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

test('a later payment adds to cash already recorded', () => {
  const applied = applyManualInvoicePayment(100, 40, 60);
  assert.equal(applied.paymentStatus, 'paid');
  assert.equal(applied.stripePaidAmountCents, 10000);
  assert.equal(applied.overpaidAmount, 0);
});
