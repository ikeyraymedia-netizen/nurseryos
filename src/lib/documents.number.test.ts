import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invoiceNumberNeedsFreshAllocation } from './documents';

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
