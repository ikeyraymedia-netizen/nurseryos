import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFeeCents, cardFeePilotTenant, cardPaymentsEnabled } from './cardFee';

test('card fee is a percent of the balance, rounded to the cent', () => {
  assert.equal(cardFeeCents(10000, 3), 300);
  assert.equal(cardFeeCents(10050, 3), 302);
  assert.equal(cardFeeCents(10000, 0), 0);
  assert.equal(cardFeeCents(0, 3), 0);
});

test('the card fee pilot is Bayou State only', () => {
  assert.equal(cardFeePilotTenant({ id: 'bayou-state-plant-co-2805ux' }), true);
  assert.equal(cardFeePilotTenant({ publicAvailabilitySlug: 'bayou-state' }), true);
  assert.equal(cardFeePilotTenant({ name: 'Bayou State Plant Co' }), true);
  assert.equal(cardFeePilotTenant({ id: 'other-nursery', name: 'Other Nursery' }), false);
  assert.equal(cardFeePilotTenant(null), false);
});

test('cards stay off until this invoice turns the fee on with a percent from 0.1 to 10', () => {
  assert.equal(cardPaymentsEnabled(true, 3), true);
  assert.equal(cardPaymentsEnabled(true, 0.1), true);
  assert.equal(cardPaymentsEnabled(true, 10), true);
  assert.equal(cardPaymentsEnabled(true, 0), false);
  assert.equal(cardPaymentsEnabled(true, 10.5), false);
  assert.equal(cardPaymentsEnabled(false, 3), false);
  assert.equal(cardPaymentsEnabled(undefined, undefined), false);
});
