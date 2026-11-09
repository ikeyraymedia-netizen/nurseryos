import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomerDocument, VendorBill } from '../types';
import {
  buildCashMovement,
  buildProfitAndLoss,
  buildSalesTaxReport,
  buildTransactionList,
  buildTrialBalance
} from './accountingReports';

function invoice(partial: Partial<CustomerDocument>): CustomerDocument {
  return {
    id: partial.id || 'inv',
    customerId: 'c',
    customerName: 'Acme',
    type: 'invoice',
    documentNumber: '100',
    documentDate: '2026-06-01',
    items: [],
    subtotal: 100,
    salesTax: 0,
    grandTotal: 100,
    billToName: 'Acme',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...partial
  } as CustomerDocument;
}

function bill(partial: Partial<VendorBill>): VendorBill {
  return {
    id: 'bill',
    vendorId: 'v',
    vendorName: 'Grower',
    billNumber: 'B-1',
    status: 'unpaid',
    billDate: '2026-06-02',
    items: [],
    subtotal: 40,
    grandTotal: 40,
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...partial
  } as VendorBill;
}

const asOf = new Date(2026, 10, 9);

test('sales tax keeps exempt wholesale out of taxable sales', () => {
  const report = buildSalesTaxReport(
    [
      invoice({ id: 'exempt', subtotal: 100, salesTax: 0, grandTotal: 100, taxRate: 0 }),
      invoice({
        id: 'taxed',
        documentNumber: '101',
        subtotal: 200,
        salesTax: 8.9,
        grandTotal: 208.9,
        taxRate: 4.45
      }),
      invoice({
        id: 'credit',
        type: 'credit_memo',
        documentNumber: 'CM-1',
        subtotal: 20,
        salesTax: 0.89,
        grandTotal: 20.89,
        taxRate: 4.45
      })
    ],
    'year',
    asOf
  );
  assert.equal(report.taxableSales, 180);
  assert.equal(report.exemptSales, 100);
  assert.equal(report.salesTaxCollected, 8.01);
});

test('profit and loss excludes sales tax and subtracts a credit memo', () => {
  const report = buildProfitAndLoss(
    [
      invoice({
        subtotal: 100,
        discount: 10,
        freightCharge: 5,
        salesTax: 4,
        grandTotal: 99
      }),
      invoice({
        id: 'cm',
        type: 'credit_memo',
        documentNumber: 'CM-1',
        subtotal: 20,
        salesTax: 0,
        grandTotal: 20
      })
    ],
    [],
    'year',
    asOf
  );
  assert.equal(report.productSales, 80);
  assert.equal(report.discounts, 10);
  assert.equal(report.freightIncome, 5);
  assert.equal(report.netSales, 75);
  assert.equal(report.salesTax, 4);
  assert.equal(report.netOperating, 75);
});

test('cash basis waits for the recorded payment', () => {
  const unpaid = buildProfitAndLoss(
    [invoice({ paymentStatus: 'unpaid', subtotal: 100, grandTotal: 100 })],
    [],
    'year',
    asOf,
    'cash'
  );
  assert.equal(unpaid.netSales, 0);

  const paid = buildProfitAndLoss(
    [
      invoice({
        paymentStatus: 'paid',
        paidAt: '2026-06-15T00:00:00.000Z',
        subtotal: 100,
        salesTax: 10,
        grandTotal: 110
      })
    ],
    [],
    'year',
    asOf,
    'cash'
  );
  assert.equal(paid.netSales, 100);
  assert.equal(paid.salesTax, 10);
});

test('cash movement includes a partial vendor payment', () => {
  const cash = buildCashMovement(
    [],
    [bill({ status: 'unpaid', amountPaid: 15, paidAt: '2026-06-20T00:00:00.000Z', grandTotal: 40 })],
    'year',
    asOf
  );
  assert.equal(cash.cashOut, 15);
});

test('trial balance debits equal credits', () => {
  const tb = buildTrialBalance(
    [
      invoice({
        paymentStatus: 'paid',
        paidAt: '2026-06-15T00:00:00.000Z',
        subtotal: 100,
        salesTax: 10,
        grandTotal: 110
      })
    ],
    [bill({ status: 'paid', amountPaid: 40, paidAt: '2026-06-20T00:00:00.000Z', grandTotal: 40 })],
    [],
    asOf
  );
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, tb.totalCredit);
});

test('transaction list records the invoice and the payment', () => {
  const list = buildTransactionList(
    [
      invoice({
        paymentStatus: 'paid',
        paidAt: '2026-06-15T00:00:00.000Z',
        paymentReference: '1234',
        grandTotal: 110,
        subtotal: 100,
        salesTax: 10
      })
    ],
    [],
    'year',
    asOf
  );
  assert.deepEqual(
    list.rows.map((row) => row.type).sort(),
    ['Invoice', 'Payment']
  );
});
