import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVendorPullListsForOrders } from './pullSheet.ts';
import type { CustomerOrder } from '../types.ts';

describe('text vendor lists and called in', () => {
  it('keeps called lines marked on screen and out of the text that gets sent', () => {
    const order = {
      id: 'o1',
      customerName: 'LSI',
      orderNumber: '100',
      dateCreated: '2026-10-27',
      originalText: '',
      status: 'pending',
      totalWeightLbs: 0,
      items: [
        {
          id: 'a',
          plantName: 'Live oak',
          containerSize: '#15',
          quantity: 10,
          loadedQuantity: 0,
          vendor: 'Windmill',
          calledIn: true
        },
        {
          id: 'b',
          plantName: 'Maple',
          containerSize: '#3',
          quantity: 4,
          loadedQuantity: 0,
          vendor: 'Windmill'
        }
      ]
    } as CustomerOrder;

    const [list] = buildVendorPullListsForOrders({ orders: [order], nurseryName: 'Bayou' });
    assert.equal(list.vendor, 'Windmill');
    assert.equal(list.sections[0].lines[0].calledIn, true);
    assert.equal(list.sections[0].lines[1].calledIn, false);
    assert.match(list.sections[0].lines[0].label, /Live oak/);
    assert.match(list.text, /Live oak/);
    assert.equal(list.text.includes('Called'), false);
    assert.equal(list.text.includes('Not called'), false);
  });
});
