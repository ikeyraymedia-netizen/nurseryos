import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reportAccessFor,
  reportScopeNote,
  reportToolNames,
  scopeReportLedger,
  scopeReportOverview,
  type ReportLedger
} from './reportTools.ts';

const supervisor = reportAccessFor({
  canViewReports: false,
  canViewOrders: true,
  canViewTrucks: true,
  canViewInventory: true,
  canViewInvoices: false,
  canViewPricing: false,
  canViewProfit: false,
  canViewPurchasingDesk: false,
  canUseVendors: true,
  canViewDirectShipOrders: false
});

const ledger: ReportLedger = {
  documents: [
    {
      type: 'invoice',
      number: '1001',
      customer: 'SiteOne',
      date: '2026-10-01',
      subtotal: 100,
      tax: 0,
      freight: 0,
      discount: 0,
      total: 100,
      lines: [{ plant: 'Oak', size: '#15', qty: 2, price: 50, cost: 20 }]
    }
  ],
  orders: [
    {
      orderNumber: 'A1',
      customer: 'SiteOne',
      date: '2026-10-20',
      status: 'loading',
      truck: 'Truck 1',
      directShip: false,
      items: [
        {
          plant: 'Oak',
          size: '#15',
          qty: 2,
          loaded: 1,
          pulled: 2,
          price: 50,
          cost: 20,
          vendor: 'Grower'
        }
      ]
    },
    {
      orderNumber: 'DS1',
      customer: 'Hidden',
      date: '2026-10-20',
      status: 'pending',
      directShip: true,
      items: [{ plant: 'Maple', size: '#5', qty: 1, loaded: 0, pulled: 0, price: 10 }]
    }
  ],
  trucks: [
    { name: 'Truck 1', status: 'loading', orderNumbers: ['A1'], directShip: false },
    { name: 'Direct', status: 'pending', orderNumbers: ['DS1'], directShip: true }
  ],
  inventory: [{ plant: 'Oak', size: '#15', qty: 4, listPrice: 50 }],
  vendorBills: [
    {
      vendor: 'Grower',
      billNumber: 'B1',
      date: '2026-10-01',
      status: 'unpaid',
      total: 80,
      lines: [{ item: 'Oak', size: '#15', qty: 2, unitCost: 40 }]
    }
  ]
};

test('supervisor report data keeps yard loads and drops money', () => {
  const scoped = scopeReportLedger(ledger, supervisor);
  assert.deepEqual(scoped.documents, []);
  assert.equal(scoped.vendorBills, undefined);
  assert.deepEqual(
    scoped.orders?.map((order) => order.orderNumber),
    ['A1']
  );
  assert.equal(scoped.orders?.[0].customer, 'SiteOne');
  assert.equal(scoped.orders?.[0].items[0].qty, 2);
  assert.equal('price' in scoped.orders![0].items[0], false);
  assert.equal('cost' in scoped.orders![0].items[0], false);
  assert.equal(scoped.orders?.[0].items[0].vendor, 'Grower');
  assert.deepEqual(
    scoped.trucks?.map((truck) => truck.name),
    ['Truck 1']
  );
  assert.equal('listPrice' in (scoped.inventory?.[0] || {}), false);
  assert.equal(scoped.inventory?.[0].qty, 4);
  assert.deepEqual(reportToolNames(supervisor), ['query_orders', 'query_inventory', 'query_trucks']);
  assert.match(reportScopeNote(supervisor), /not available on this account/);
  const overview = scopeReportOverview(
    { sales: { byCustomer: [{ customerName: 'SiteOne', salesTotal: 100 }] } },
    scoped,
    supervisor
  ) as { sales?: unknown; summary?: { orders?: number } };
  assert.equal(overview.sales, undefined);
  assert.equal(overview.summary?.orders, 1);
});

test('office reports still include invoices', () => {
  const office = reportAccessFor({
    canViewReports: true,
    canViewOrders: false,
    canViewTrucks: false,
    canViewInventory: false,
    canViewInvoices: true,
    canViewPricing: true,
    canViewProfit: true,
    canViewPurchasingDesk: true,
    canUseVendors: false,
    canViewDirectShipOrders: false
  });
  const scoped = scopeReportLedger(ledger, office);
  assert.equal(scoped.documents?.length, 1);
  assert.equal(scoped.documents?.[0].total, 100);
  assert.equal(scoped.documents?.[0].lines[0].price, 50);
  assert.equal(scoped.orders?.length, 1);
  assert.equal(scoped.vendorBills?.length, 1);
  assert.equal(reportScopeNote(office), '');
});
