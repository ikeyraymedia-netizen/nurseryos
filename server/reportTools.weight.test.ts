import assert from 'node:assert/strict';
import test from 'node:test';
import { applyContainerWeights, runReportTool, type ReportLedger } from './reportTools.ts';

const ledger: ReportLedger = {
  orders: [
    {
      orderNumber: '1',
      customer: 'A',
      date: '2026-10-28',
      status: 'loading',
      truck: 'North',
      loadingDate: '2026-10-28',
      items: [
        { plant: 'Oak', size: '#15', qty: 2, loaded: 2, pulled: 2, weightLbs: 40 },
        { plant: 'Fern', size: 'tray', qty: 5, loaded: 1, pulled: 1, weightLbs: null }
      ]
    },
    {
      orderNumber: '2',
      customer: 'B',
      date: '2026-10-28',
      status: 'completed',
      truck: 'South',
      loadingDate: '2026-10-28',
      items: [{ plant: 'Maple', size: '#3', qty: 4, loaded: 3, pulled: 4, weightLbs: 10 }]
    },
    {
      orderNumber: '3',
      customer: 'C',
      date: '2026-10-27',
      status: 'completed',
      truck: 'West',
      loadingDate: '2026-10-27',
      items: [{ plant: 'Pine', size: '#7', qty: 1, loaded: 1, pulled: 1, weightLbs: 100 }]
    }
  ],
  trucks: [
    { name: 'North', status: 'loading', loadingDate: '2026-10-28', orderNumbers: ['1'] },
    { name: 'South', status: 'completed', loadingDate: '2026-10-28', orderNumbers: ['2'] },
    { name: 'West', status: 'completed', loadingDate: '2026-10-27', orderNumbers: ['3'] }
  ]
};

test('pounds loaded add across every truck on that day', () => {
  const result = runReportTool(ledger, 'query_trucks', {
    loadingFrom: '2026-10-28',
    loadingTo: '2026-10-28',
    groupBy: 'truck'
  }) as {
    count: number;
    totals: { loadedLbs: number; orderLbs: number; unweightedLoadedQty: number };
    rows: Array<{ key: string; loadedLbs: number }>;
  };

  assert.equal(result.count, 2);
  assert.equal(result.totals.loadedLbs, 110);
  assert.equal(result.totals.orderLbs, 120);
  assert.equal(result.totals.unweightedLoadedQty, 1);
  assert.deepEqual(
    result.rows.map((row) => [row.key, row.loadedLbs]),
    [
      ['North', 80],
      ['South', 30]
    ]
  );
});

test('container weights are matched by size label', () => {
  const stamped = applyContainerWeights(
    {
      orders: [
        {
          orderNumber: '1',
          customer: 'A',
          date: '2026-10-28',
          status: 'loading',
          items: [{ plant: 'Oak', size: '#15', qty: 1, loaded: 1, pulled: 1 }]
        }
      ]
    },
    [{ id: '15_gallon', label: '#15', weightLbs: 45 }]
  );
  assert.equal(stamped.orders?.[0].items[0].weightLbs, 45);
});

test('order query uses the same loaded pounds for a loading day', () => {
  const result = runReportTool(ledger, 'query_orders', {
    loadingFrom: '2026-10-28',
    loadingTo: '2026-10-28'
  }) as { totals: { loadedLbs: number; unweightedLoadedQty: number } };

  assert.equal(result.totals.loadedLbs, 110);
  assert.equal(result.totals.unweightedLoadedQty, 1);
});
