import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BAYOU_INVOICE_NUMBER_START,
  invoiceNumberNeedsFreshAllocation,
  nextNumberInSequence
} from './documents';

describe('invoice number when an estimate is filed as an invoice', () => {
  it('replaces an EST number', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'invoice',
        enteredNumber: 'EST-46340055',
        priorType: 'estimate'
      }),
      true
    );
  });

  it('replaces the temporary invoice placeholder', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'invoice',
        enteredNumber: '1000',
        priorType: 'estimate'
      }),
      true
    );
  });

  it('keeps a real invoice number already chosen', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'invoice',
        enteredNumber: '46340110',
        priorType: 'estimate'
      }),
      false
    );
  });

  it('leaves an invoice that was already saved under an EST number', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'invoice',
        enteredNumber: 'EST-46340055',
        priorType: 'invoice'
      }),
      false
    );
  });

  it('treats the Bayou State starting number as a placeholder', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'invoice',
        enteredNumber: String(BAYOU_INVOICE_NUMBER_START),
        priorType: 'estimate',
        tenantId: 'bayou-state-plant-co-2805ux'
      }),
      true
    );
  });

  it('does not renumber an estimate that stays an estimate', () => {
    assert.equal(
      invoiceNumberNeedsFreshAllocation({
        type: 'estimate',
        enteredNumber: 'EST-46340055',
        priorType: 'estimate'
      }),
      false
    );
  });
});

describe('Bayou State invoice numbers', () => {
  it('starts at 4000 and skips the old long numbers', () => {
    assert.equal(nextNumberInSequence([46340110, 12], 4000, 100_000), 4000);
    assert.equal(nextNumberInSequence([46340110, 4000, 4001], 4000, 100_000), 4002);
  });
});
