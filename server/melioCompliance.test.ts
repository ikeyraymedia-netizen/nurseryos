import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MELIO_CARD_GOODS_CENTS,
  buildMelioPaymentCompliance,
  requireMelioSonarToken
} from './melioCompliance.ts';

const address = {
  line1: '1 Main St',
  city: 'Baton Rouge',
  state: 'la',
  postalCode: '70808'
};

test('bank payments do not send card details', () => {
  assert.deepEqual(
    buildMelioPaymentCompliance({
      fundingType: 'ach',
      amountCents: MELIO_CARD_GOODS_CENTS + 1,
      goodsReceived: false
    }),
    { type: 'goods-and-services' }
  );
});

test('a card payment needs a 4-digit category and a business address', () => {
  assert.throws(
    () => buildMelioPaymentCompliance({ fundingType: 'card', amountCents: 10_000 }),
    /category code/
  );
  assert.throws(
    () =>
      buildMelioPaymentCompliance({
        fundingType: 'card',
        amountCents: 10_000,
        merchantCategoryCode: '5193',
        merchantAddress: { line1: '1 Main', city: 'Baton Rouge', state: 'LA', postalCode: '' }
      }),
    /ZIP/
  );
});

test('a card payment over $3,000 requires the goods-received confirmation', () => {
  assert.throws(
    () =>
      buildMelioPaymentCompliance({
        fundingType: 'card',
        amountCents: MELIO_CARD_GOODS_CENTS + 1,
        merchantCategoryCode: '5193',
        merchantAddress: address
      }),
    /goods or services/
  );
  const compliance = buildMelioPaymentCompliance({
    fundingType: 'card',
    amountCents: MELIO_CARD_GOODS_CENTS + 1,
    merchantCategoryCode: '5193',
    merchantAddress: address,
    goodsReceived: true
  });
  assert.equal(compliance.goodsReceived, true);
  assert.equal(compliance.card?.merchantCategoryCode, '5193');
  assert.equal(compliance.card?.merchantAddress.state, 'LA');
});

test('a card payment of exactly $3,000 does not require the checkbox', () => {
  const compliance = buildMelioPaymentCompliance({
    fundingType: 'card',
    amountCents: MELIO_CARD_GOODS_CENTS,
    merchantCategoryCode: '5261',
    merchantAddress: address
  });
  assert.equal(compliance.goodsReceived, undefined);
});

test('a Melio write without Sonar is rejected', () => {
  assert.equal(requireMelioSonarToken('  abc  '), 'abc');
  assert.throws(() => requireMelioSonarToken(''), /Sonar is required/);
});
