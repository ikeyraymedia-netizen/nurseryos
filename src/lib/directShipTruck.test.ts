import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerOrder, Truck } from '../types';
import {
  applyOrderTruckPatches,
  directShipTruckOrderIds,
  ordersSelectableForTruck,
  planTruckOrderAssignment
} from './directShipTruck';

function order(partial: Partial<CustomerOrder> & Pick<CustomerOrder, 'id'>): CustomerOrder {
  return {
    customerName: partial.id,
    orderNumber: partial.id,
    dateCreated: '2026-11-18T00:00:00.000Z',
    items: [],
    originalText: '',
    status: 'pending',
    totalWeightLbs: 0,
    ...partial
  };
}

function truck(partial: Partial<Truck> & Pick<Truck, 'id' | 'orderIds'>): Truck {
  return {
    name: partial.id,
    dateCreated: '2026-11-18T00:00:00.000Z',
    status: 'pending',
    ...partial
  };
}

test('a direct ship truck can take several unassigned orders and other direct ships', () => {
  const orders = [
    order({ id: 'a' }),
    order({ id: 'b', directShip: true }),
    order({ id: 'c', directShip: true, truckId: 'solo' }),
    order({ id: 'yard', truckId: 'yard-1' })
  ];
  const trucks = [
    truck({ id: 'solo', orderIds: ['c'], directShip: true, truckType: 'Direct ship' }),
    truck({ id: 'yard-1', orderIds: ['yard'], truckType: "28' Gooseneck" })
  ];
  const selectable = ordersSelectableForTruck(orders, trucks, null, true).map((item) => item.id);
  assert.deepEqual(selectable, ['a', 'b', 'c']);
});

test('a normal truck still hides direct ship orders', () => {
  const orders = [
    order({ id: 'a' }),
    order({ id: 'b', directShip: true }),
    order({ id: 'c', truckId: 'yard-1' })
  ];
  const selectable = ordersSelectableForTruck(orders, [], 'yard-1', false).map((item) => item.id);
  assert.deepEqual(selectable, ['a', 'c']);
});

test('saving a ship date keeps the other orders on the direct ship truck', () => {
  assert.deepEqual(directShipTruckOrderIds({ orderIds: ['a', 'b', 'c'] }, 'b'), ['a', 'b', 'c']);
});

test('putting orders on one direct ship marks them and retires the empty solo truck', () => {
  const shared = truck({
    id: 'shared',
    name: 'Kryslee direct',
    orderIds: ['a', 'b'],
    directShip: true,
    truckType: 'Direct ship',
    loadingDate: '2026-11-20'
  });
  const solo = truck({
    id: 'solo',
    orderIds: ['b'],
    directShip: true,
    truckType: 'Direct ship'
  });
  const plan = planTruckOrderAssignment({
    trucks: [solo],
    truck: shared,
    previousOrderIds: []
  });
  assert.deepEqual(
    plan.trucks.map((item) => item.id),
    ['shared']
  );
  assert.deepEqual(plan.emptiedDirectShipTruckIds, ['solo']);
  const next = applyOrderTruckPatches(
    [order({ id: 'a' }), order({ id: 'b', directShip: true, truckId: 'solo' })],
    plan.orderPatches
  );
  assert.equal(next[0].directShip, true);
  assert.equal(next[0].directShipDate, '2026-11-20');
  assert.equal(next[0].truckId, 'shared');
  assert.equal(next[1].truckId, 'shared');
});

test('taking an order off a direct ship returns it to the normal list', () => {
  const before = truck({
    id: 'shared',
    orderIds: ['a', 'b'],
    directShip: true,
    truckType: 'Direct ship',
    loadingDate: '2026-11-20'
  });
  const after = { ...before, orderIds: ['a'] };
  const plan = planTruckOrderAssignment({
    trucks: [before],
    truck: after,
    previousOrderIds: ['a', 'b']
  });
  const next = applyOrderTruckPatches(
    [
      order({ id: 'a', directShip: true, directShipDate: '2026-11-20', truckId: 'shared' }),
      order({ id: 'b', directShip: true, directShipDate: '2026-11-20', truckId: 'shared' })
    ],
    plan.orderPatches
  );
  assert.equal(next[0].directShip, true);
  assert.equal(next[1].directShip, undefined);
  assert.equal(next[1].truckId, null);
  assert.equal(next[1].directShipDate, undefined);
});
