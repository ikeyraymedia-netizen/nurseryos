import { CustomerDocument, VendorBill } from '../types';
import { invoiceAmountPaid, invoiceBalanceDue } from './documents';
import { billAmountPaid, billBalanceDue } from './manualPayment';
import {
  billDiscountFactor,
  purchaseCategoryLabel,
  isPlantPurchaseCategory
} from './purchaseCategories';

export type AccountingPeriod = 'month' | 'quarter' | 'year' | 'all';

/** Accrual uses the invoice or bill date. Cash uses the date the money moved. */
export type AccountingBasis = 'accrual' | 'cash';

export type AgingBucketId = 'current' | 'b1_30' | 'b31_60' | 'b61_90' | 'b90_plus';

export interface AgingBucket {
  id: AgingBucketId;
  label: string;
  amount: number;
  count: number;
}

export interface AgingRow {
  name: string;
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  b90_plus: number;
  total: number;
}

export interface AgingReport {
  asOf: string;
  buckets: AgingBucket[];
  rows: AgingRow[];
  total: number;
}

export interface PlReport {
  periodLabel: string;
  basis: AccountingBasis;
  /** Plant and supply sales before discounts and freight. Credit memos reduce this. */
  productSales: number;
  /** Kept so older callers still read a top-line sales figure (net of tax). */
  revenue: number;
  salesTax: number;
  freightIncome: number;
  discounts: number;
  netSales: number;
  cogsFromInvoices: number;
  cogsFromVendorPlants: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  operatingExpenses: number;
  expensesByCategory: Array<{ category: string; amount: number }>;
  netOperating: number;
  invoiceCount: number;
  billCount: number;
  notes: string[];
}

export interface SalesTaxLine {
  date: string;
  num: string;
  name: string;
  kind: 'taxable' | 'exempt' | 'credit';
  ratePct: number;
  taxable: number;
  tax: number;
}

export interface SalesTaxReport {
  periodLabel: string;
  basis: AccountingBasis;
  /** Sales that had sales tax charged. */
  taxableSales: number;
  /** Wholesale and other invoices with no sales tax. */
  exemptSales: number;
  salesTaxCollected: number;
  invoiceCount: number;
  byRate: Array<{ ratePct: number; taxable: number; tax: number; invoiceCount: number; exempt: boolean }>;
  lines: SalesTaxLine[];
}

export interface CashMovementReport {
  periodLabel: string;
  cashIn: number;
  cashOut: number;
  net: number;
  inByMethod: Array<{ method: string; amount: number; count: number }>;
  outByMethod: Array<{ method: string; amount: number; count: number }>;
  inRows: Array<{ date: string; name: string; method: string; amount: number; ref?: string }>;
  outRows: Array<{ date: string; name: string; method: string; amount: number; ref?: string }>;
}

export interface ExpenseReport {
  periodLabel: string;
  basis: AccountingBasis;
  total: number;
  byCategory: Array<{ category: string; amount: number; count: number }>;
  byVendor: Array<{ vendor: string; amount: number; count: number }>;
  lines: Array<{ date: string; vendor: string; num: string; category: string; amount: number }>;
}

function parseDate(raw?: string | null): Date | null {
  if (!raw) return null;
  const day = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysPastDue(asOf: Date, dueOrDoc: Date): number {
  const a = startOfLocalDay(asOf).getTime();
  const b = startOfLocalDay(dueOrDoc).getTime();
  return Math.floor((a - b) / 86400000);
}

function bucketForDays(daysOverdue: number): AgingBucketId {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'b1_30';
  if (daysOverdue <= 60) return 'b31_60';
  if (daysOverdue <= 90) return 'b61_90';
  return 'b90_plus';
}

export function periodBounds(
  period: AccountingPeriod,
  now = new Date()
): { start: Date | null; end: Date; label: string } {
  const end = now;
  if (period === 'all') {
    return { start: null, end, label: 'All time' };
  }
  if (period === 'year') {
    const start = new Date(now.getFullYear(), 0, 1);
    return { start, end, label: String(now.getFullYear()) };
  }
  if (period === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    const start = new Date(now.getFullYear(), q * 3, 1);
    return { start, end, label: `Q${q + 1} ${now.getFullYear()}` };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const label = start.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  return { start, end, label };
}

function inPeriod(raw: string | undefined | null, start: Date | null, end: Date): boolean {
  const d = parseDate(raw);
  if (!d) return false;
  const day = startOfLocalDay(d);
  if (start && day < startOfLocalDay(start)) return false;
  if (day > startOfLocalDay(end)) return false;
  return true;
}

function emptyBuckets(): Record<AgingBucketId, { amount: number; count: number }> {
  return {
    current: { amount: 0, count: 0 },
    b1_30: { amount: 0, count: 0 },
    b31_60: { amount: 0, count: 0 },
    b61_90: { amount: 0, count: 0 },
    b90_plus: { amount: 0, count: 0 }
  };
}

const BUCKET_LABELS: Record<AgingBucketId, string> = {
  current: 'Current',
  b1_30: '1–30 days',
  b31_60: '31–60 days',
  b61_90: '61–90 days',
  b90_plus: '90+ days'
};

function finalizeAging(
  asOf: Date,
  totals: Record<AgingBucketId, { amount: number; count: number }>,
  rowMap: Map<string, AgingRow>
): AgingReport {
  const buckets: AgingBucket[] = (Object.keys(BUCKET_LABELS) as AgingBucketId[]).map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    amount: totals[id].amount,
    count: totals[id].count
  }));
  const rows = [...rowMap.values()].sort((a, b) => b.total - a.total);
  const total = buckets.reduce((s, b) => s + b.amount, 0);
  return {
    asOf: asOf.toISOString().slice(0, 10),
    buckets,
    rows,
    total
  };
}

/** Open customer invoices aged by due date (falls back to invoice date). */
export function buildArAging(documents: CustomerDocument[], asOf = new Date()): AgingReport {
  const totals = emptyBuckets();
  const rowMap = new Map<string, AgingRow>();

  for (const doc of documents) {
    if (doc.type === 'credit_memo') {
      const credit = Math.abs(doc.grandTotal || 0);
      if (credit <= 0) continue;
      const name = doc.customerName || 'Unknown customer';
      const row =
        rowMap.get(name) ||
        ({
          name,
          current: 0,
          b1_30: 0,
          b31_60: 0,
          b61_90: 0,
          b90_plus: 0,
          total: 0
        } satisfies AgingRow);
      row.current -= credit;
      row.total -= credit;
      rowMap.set(name, row);
      totals.current.amount -= credit;
      continue;
    }
    if (doc.type !== 'invoice') continue;
    const amount = invoiceBalanceDue(doc);
    if (amount <= 0.009) continue;
    const due = parseDate(doc.dueDate) || parseDate(doc.documentDate) || parseDate(doc.createdAt);
    if (!due) continue;
    const bucket = bucketForDays(daysPastDue(asOf, due));
    totals[bucket].amount += amount;
    totals[bucket].count += 1;

    const name = doc.customerName || 'Unknown customer';
    const row =
      rowMap.get(name) ||
      ({
        name,
        current: 0,
        b1_30: 0,
        b31_60: 0,
        b61_90: 0,
        b90_plus: 0,
        total: 0
      } satisfies AgingRow);
    row[bucket] += amount;
    row.total += amount;
    rowMap.set(name, row);
  }

  for (const id of Object.keys(BUCKET_LABELS) as AgingBucketId[]) {
    totals[id].amount = Math.max(0, totals[id].amount);
  }
  for (const [name, row] of [...rowMap.entries()]) {
    row.current = Math.max(0, row.current);
    row.b1_30 = Math.max(0, row.b1_30);
    row.b31_60 = Math.max(0, row.b31_60);
    row.b61_90 = Math.max(0, row.b61_90);
    row.b90_plus = Math.max(0, row.b90_plus);
    row.total = row.current + row.b1_30 + row.b31_60 + row.b61_90 + row.b90_plus;
    if (row.total <= 0.005) rowMap.delete(name);
  }

  return finalizeAging(asOf, totals, rowMap);
}

/** Open vendor bills aged by due date (falls back to bill date). */
export function buildApAging(bills: VendorBill[], asOf = new Date()): AgingReport {
  const totals = emptyBuckets();
  const rowMap = new Map<string, AgingRow>();

  for (const bill of bills) {
    if (bill.status === 'paid') continue;
    const amount = billBalanceDue(bill);
    if (amount <= 0) continue;
    const due = parseDate(bill.dueDate) || parseDate(bill.billDate) || parseDate(bill.createdAt);
    if (!due) continue;
    const bucket = bucketForDays(daysPastDue(asOf, due));
    totals[bucket].amount += amount;
    totals[bucket].count += 1;

    const name = bill.vendorName || 'Unknown vendor';
    const row =
      rowMap.get(name) ||
      ({
        name,
        current: 0,
        b1_30: 0,
        b31_60: 0,
        b61_90: 0,
        b90_plus: 0,
        total: 0
      } satisfies AgingRow);
    row[bucket] += amount;
    row.total += amount;
    rowMap.set(name, row);
  }

  return finalizeAging(asOf, totals, rowMap);
}

function invoiceCogs(doc: CustomerDocument): number {
  let cost = 0;
  for (const item of doc.items || []) {
    if (item.unitPrice == null || !Number.isFinite(item.unitPrice)) continue;
    cost += (item.quantity || 0) * (item.unitCost || 0);
  }
  return cost;
}

function billLineTotal(bill: VendorBill): number {
  return (bill.items || []).reduce(
    (s, line) => s + (line.quantity || 0) * (line.unitCost || 0),
    0
  );
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Invoice and credit-memo pieces. Credits are negative so they reduce income. */
function documentIncomeParts(doc: CustomerDocument) {
  const sign = doc.type === 'credit_memo' ? -1 : 1;
  const subtotal = Math.abs(doc.subtotal || 0) * sign;
  const discount = Math.abs(doc.discount || 0) * sign;
  const freight = Math.abs(doc.freightCharge || 0) * sign;
  const tax = Math.abs(doc.salesTax || 0) * sign;
  const total = Math.abs(doc.grandTotal || 0) * sign;
  return { subtotal, discount, freight, tax, total };
}

/**
 * Share of an invoice recognized on the cash basis.
 * Sales tax stays out of income. Amounts above the invoice total stay out too.
 */
function cashIncomeRatio(doc: CustomerDocument): number {
  const total = Math.abs(doc.grandTotal || 0);
  const paid = invoiceAmountPaid(doc);
  if (paid <= 0.009 || total <= 0.009) return 0;
  return Math.min(paid, total) / total;
}

function addExpenseAmount(
  map: Map<string, number>,
  category: string,
  amount: number,
  into: { operating: number; plant: number }
) {
  if (Math.abs(amount) <= 0.0001) return;
  if (isPlantPurchaseCategory(category)) into.plant += amount;
  else {
    into.operating += amount;
    map.set(category, (map.get(category) || 0) + amount);
  }
}

export function buildProfitAndLoss(
  documents: CustomerDocument[],
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date(),
  basis: AccountingBasis = 'accrual'
): PlReport {
  const { start, end, label } = periodBounds(period, now);
  let productSales = 0;
  let salesTax = 0;
  let freightIncome = 0;
  let discounts = 0;
  let cogsFromInvoices = 0;
  let invoiceCount = 0;

  for (const doc of documents) {
    if (doc.type !== 'invoice' && doc.type !== 'credit_memo') continue;
    const parts = documentIncomeParts(doc);
    if (basis === 'cash' && doc.type === 'invoice') {
      if (!inPeriod(doc.paidAt || doc.documentDate || doc.createdAt, start, end)) continue;
      const ratio = cashIncomeRatio(doc);
      if (ratio <= 0) continue;
      invoiceCount += 1;
      productSales += parts.subtotal * ratio;
      salesTax += parts.tax * ratio;
      freightIncome += parts.freight * ratio;
      discounts += parts.discount * ratio;
      cogsFromInvoices += invoiceCogs(doc) * ratio;
      continue;
    }
    const when =
      doc.type === 'credit_memo'
        ? doc.documentDate || doc.createdAt
        : doc.documentDate || doc.createdAt;
    if (!inPeriod(when, start, end)) continue;
    invoiceCount += 1;
    productSales += parts.subtotal;
    salesTax += parts.tax;
    freightIncome += parts.freight;
    discounts += parts.discount;
    if (doc.type === 'invoice') cogsFromInvoices += invoiceCogs(doc);
  }

  let cogsFromVendorPlants = 0;
  let operatingExpenses = 0;
  let billCount = 0;
  const expenseMap = new Map<string, number>();
  const sink = { operating: 0, plant: 0 };

  for (const bill of bills) {
    const paid = billAmountPaid(bill);
    const ratio =
      basis === 'cash'
        ? (bill.grandTotal || 0) > 0.009
          ? Math.min(Math.max(paid, 0), bill.grandTotal || 0) / (bill.grandTotal || 1)
          : 0
        : 1;
    if (basis === 'cash' && ratio <= 0) continue;
    const when =
      basis === 'cash'
        ? bill.paidAt || bill.billDate || bill.createdAt
        : bill.billDate || bill.createdAt;
    if (!inPeriod(when, start, end)) continue;
    billCount += 1;
    const lines = bill.items || [];
    const factor = billDiscountFactor(bill) * ratio;
    if (lines.length === 0) {
      const amt = (bill.grandTotal || 0) * ratio;
      sink.operating += amt;
      expenseMap.set('Other', (expenseMap.get('Other') || 0) + amt);
    } else {
      for (const line of lines) {
        const amt = (line.quantity || 0) * (line.unitCost || 0) * factor;
        const category = purchaseCategoryLabel(
          line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
        );
        addExpenseAmount(expenseMap, category, amt, sink);
      }
      if (bill.freightCharge) {
        const freight = bill.freightCharge * factor;
        sink.operating += freight;
        expenseMap.set('Freight', (expenseMap.get('Freight') || 0) + freight);
      }
    }
  }
  cogsFromVendorPlants = sink.plant;
  operatingExpenses = sink.operating;

  const cogs = cogsFromInvoices > 0 ? cogsFromInvoices : cogsFromVendorPlants;
  const netSales = productSales - discounts + freightIncome;
  const grossProfit = netSales - cogs;
  const grossMarginPct = netSales > 0.009 ? (grossProfit / netSales) * 100 : 0;
  const netOperating = grossProfit - operatingExpenses;

  const notes: string[] = [];
  if (cogsFromInvoices <= 0 && cogsFromVendorPlants > 0) notes.push('cogs_bills');
  else if (cogsFromInvoices <= 0) notes.push('cogs_empty');
  if (basis === 'cash') notes.push('cash_basis');
  notes.push('gaap');

  return {
    periodLabel: label,
    basis,
    productSales: roundMoney(productSales),
    revenue: roundMoney(netSales),
    salesTax: roundMoney(salesTax),
    freightIncome: roundMoney(freightIncome),
    discounts: roundMoney(discounts),
    netSales: roundMoney(netSales),
    cogsFromInvoices: roundMoney(cogsFromInvoices),
    cogsFromVendorPlants: roundMoney(cogsFromVendorPlants),
    cogs: roundMoney(cogs),
    grossProfit: roundMoney(grossProfit),
    grossMarginPct,
    operatingExpenses: roundMoney(operatingExpenses),
    expensesByCategory: [...expenseMap.entries()]
      .map(([category, amount]) => ({ category, amount: roundMoney(amount) }))
      .filter((row) => Math.abs(row.amount) > 0.004)
      .sort((a, b) => b.amount - a.amount),
    netOperating: roundMoney(netOperating),
    invoiceCount,
    billCount,
    notes
  };
}

export function buildSalesTaxReport(
  documents: CustomerDocument[],
  period: AccountingPeriod,
  now = new Date(),
  basis: AccountingBasis = 'accrual'
): SalesTaxReport {
  const { start, end, label } = periodBounds(period, now);
  let taxableSales = 0;
  let exemptSales = 0;
  let salesTaxCollected = 0;
  let invoiceCount = 0;
  const byRate = new Map<string, { ratePct: number; taxable: number; tax: number; invoiceCount: number; exempt: boolean }>();
  const lines: SalesTaxLine[] = [];

  for (const doc of documents) {
    if (doc.type !== 'invoice' && doc.type !== 'credit_memo') continue;
    const when =
      basis === 'cash' && doc.type === 'invoice'
        ? doc.paidAt || doc.documentDate || doc.createdAt
        : doc.documentDate || doc.createdAt;
    if (!inPeriod(when, start, end)) continue;
    const ratio = basis === 'cash' && doc.type === 'invoice' ? cashIncomeRatio(doc) : 1;
    if (ratio <= 0) continue;
    const parts = documentIncomeParts(doc);
    const base = (parts.subtotal - parts.discount) * ratio;
    const tax = parts.tax * ratio;
    const taxed = Math.abs(tax) > 0.009;
    invoiceCount += 1;
    salesTaxCollected += tax;
    if (taxed) taxableSales += base;
    else exemptSales += base;
    const rate = taxed ? doc.taxRate || 0 : 0;
    const key = taxed ? `tax:${rate}` : 'exempt';
    const row = byRate.get(key) || { ratePct: rate, taxable: 0, tax: 0, invoiceCount: 0, exempt: !taxed };
    row.taxable += base;
    row.tax += tax;
    row.invoiceCount += 1;
    byRate.set(key, row);
    lines.push({
      date: String(when).slice(0, 10),
      num: doc.documentNumber,
      name: doc.customerName,
      kind: doc.type === 'credit_memo' ? 'credit' : taxed ? 'taxable' : 'exempt',
      ratePct: rate,
      taxable: roundMoney(base),
      tax: roundMoney(tax)
    });
  }

  lines.sort((a, b) => b.date.localeCompare(a.date) || a.num.localeCompare(b.num));

  return {
    periodLabel: label,
    basis,
    taxableSales: roundMoney(taxableSales),
    exemptSales: roundMoney(exemptSales),
    salesTaxCollected: roundMoney(salesTaxCollected),
    invoiceCount,
    byRate: [...byRate.values()].sort((a, b) => Number(a.exempt) - Number(b.exempt) || b.tax - a.tax),
    lines
  };
}

function methodLabel(method?: string | null): string {
  if (!method) return 'Unspecified';
  if (method === 'cc') return 'Card';
  if (method === 'ach') return 'ACH';
  if (method === 'stripe') return 'Stripe';
  if (method === 'wire') return 'Wire';
  if (method === 'check') return 'Check';
  return method;
}

export function buildCashMovement(
  documents: CustomerDocument[],
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date()
): CashMovementReport {
  const { start, end, label } = periodBounds(period, now);
  const inByMethod = new Map<string, { amount: number; count: number }>();
  const outByMethod = new Map<string, { amount: number; count: number }>();
  const inRows: CashMovementReport['inRows'] = [];
  const outRows: CashMovementReport['outRows'] = [];

  let cashIn = 0;
  let cashOut = 0;

  for (const doc of documents) {
    if (doc.type !== 'invoice') continue;
    const recorded =
      typeof doc.stripePaidAmountCents === 'number' ? doc.stripePaidAmountCents / 100 : null;
    const status = doc.paymentStatus || 'unpaid';
    if (status !== 'paid' && !(recorded && recorded > 0)) continue;
    const paidRaw = doc.paidAt || doc.documentDate || doc.createdAt;
    if (!inPeriod(paidRaw, start, end)) continue;
    const amount = recorded != null ? recorded : doc.grandTotal || 0;
    if (amount <= 0) continue;
    cashIn += amount;
    const method = methodLabel(doc.paymentMethod);
    const m = inByMethod.get(method) || { amount: 0, count: 0 };
    m.amount += amount;
    m.count += 1;
    inByMethod.set(method, m);
    inRows.push({
      date: String(paidRaw).slice(0, 10),
      name: doc.customerName,
      method,
      amount,
      ref: doc.paymentReference || doc.documentNumber
    });
  }

  for (const bill of bills) {
    const amount = billAmountPaid(bill);
    if (amount <= 0.009) continue;
    const paidRaw = bill.paidAt || bill.billDate || bill.createdAt;
    if (!inPeriod(paidRaw, start, end)) continue;
    cashOut += amount;
    const method = methodLabel(bill.paymentMethod);
    const m = outByMethod.get(method) || { amount: 0, count: 0 };
    m.amount += amount;
    m.count += 1;
    outByMethod.set(method, m);
    outRows.push({
      date: String(paidRaw).slice(0, 10),
      name: bill.vendorName,
      method,
      amount,
      ref: bill.paymentReference || bill.billNumber
    });
  }

  inRows.sort((a, b) => b.date.localeCompare(a.date));
  outRows.sort((a, b) => b.date.localeCompare(a.date));

  return {
    periodLabel: label,
    cashIn,
    cashOut,
    net: cashIn - cashOut,
    inByMethod: [...inByMethod.entries()]
      .map(([method, row]) => ({ method, ...row }))
      .sort((a, b) => b.amount - a.amount),
    outByMethod: [...outByMethod.entries()]
      .map(([method, row]) => ({ method, ...row }))
      .sort((a, b) => b.amount - a.amount),
    inRows,
    outRows
  };
}

export function buildExpenseReport(
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date(),
  basis: AccountingBasis = 'accrual'
): ExpenseReport {
  const { start, end, label } = periodBounds(period, now);
  const byCategory = new Map<string, { amount: number; count: number }>();
  const byVendor = new Map<string, { amount: number; count: number }>();
  const linesOut: ExpenseReport['lines'] = [];
  let total = 0;

  for (const bill of bills) {
    const paid = billAmountPaid(bill);
    const full = bill.grandTotal || billLineTotal(bill);
    const ratio =
      basis === 'cash' ? (full > 0.009 ? Math.min(Math.max(paid, 0), full) / full : 0) : 1;
    if (basis === 'cash' && ratio <= 0) continue;
    const when =
      basis === 'cash'
        ? bill.paidAt || bill.billDate || bill.createdAt
        : bill.billDate || bill.createdAt;
    if (!inPeriod(when, start, end)) continue;
    const billTotal = (full || 0) * ratio;
    total += billTotal;
    const vendor = bill.vendorName || 'Unknown vendor';
    const v = byVendor.get(vendor) || { amount: 0, count: 0 };
    v.amount += billTotal;
    v.count += 1;
    byVendor.set(vendor, v);

    const date = String(when).slice(0, 10);
    const num = bill.vendorInvoiceNumber || bill.billNumber;
    const push = (category: string, amount: number) => {
      if (Math.abs(amount) <= 0.0001) return;
      const c = byCategory.get(category) || { amount: 0, count: 0 };
      c.amount += amount;
      c.count += 1;
      byCategory.set(category, c);
      linesOut.push({ date, vendor, num, category, amount: roundMoney(amount) });
    };

    const lines = bill.items || [];
    if (lines.length === 0) {
      push('Other', billTotal);
      continue;
    }
    const factor = billDiscountFactor(bill) * ratio;
    for (const line of lines) {
      const category = purchaseCategoryLabel(
        line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
      );
      push(category, (line.quantity || 0) * (line.unitCost || 0) * factor);
    }
    if (bill.freightCharge) push('Freight', bill.freightCharge * factor);
  }

  linesOut.sort((a, b) => b.date.localeCompare(a.date) || a.vendor.localeCompare(b.vendor));

  return {
    periodLabel: label,
    basis,
    total: roundMoney(total),
    byCategory: [...byCategory.entries()]
      .map(([category, row]) => ({ category, amount: roundMoney(row.amount), count: row.count }))
      .sort((a, b) => b.amount - a.amount),
    byVendor: [...byVendor.entries()]
      .map(([vendor, row]) => ({ vendor, amount: roundMoney(row.amount), count: row.count }))
      .sort((a, b) => b.amount - a.amount),
    lines: linesOut
  };
}

export interface BalanceSheetLine {
  id: string;
  section: 'assets' | 'liabilities' | 'equity';
  amount: number;
}

export interface BalanceSheetReport {
  asOf: string;
  cashEstimated: number;
  accountsReceivable: number;
  inventoryAtCost: number;
  inventoryValuedUnits: number;
  inventoryUnvaluedUnits: number;
  totalAssets: number;
  accountsPayable: number;
  salesTaxPayable: number;
  totalLiabilities: number;
  equity: number;
  totalLiabilitiesAndEquity: number;
  balanced: boolean;
  notes: string[];
  lines: BalanceSheetLine[];
}

function plantKey(name: string, size: string): string {
  return `${String(name || '')
    .trim()
    .toLowerCase()}|${String(size || '')
    .trim()
    .toLowerCase()}`;
}

/** Latest known plant unit cost from vendor bills, then invoice lines. */
function buildPlantCostLookup(
  documents: CustomerDocument[],
  bills: VendorBill[]
): Map<string, { cost: number; at: number }> {
  const map = new Map<string, { cost: number; at: number }>();

  function consider(key: string, cost: number, atRaw?: string | null) {
    if (!key || key.startsWith('|') || key.endsWith('|') || cost <= 0) return;
    const at = parseDate(atRaw)?.getTime() || 0;
    const prev = map.get(key);
    if (!prev || at >= prev.at) map.set(key, { cost, at });
  }

  for (const bill of bills) {
    for (const line of bill.items || []) {
      const category = purchaseCategoryLabel(
        line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
      );
      if (!isPlantPurchaseCategory(category)) continue;
      consider(
        plantKey(line.plantName, line.containerSize),
        line.unitCost || 0,
        bill.billDate || bill.createdAt
      );
    }
  }

  for (const doc of documents) {
    if (doc.type !== 'invoice') continue;
    for (const item of doc.items || []) {
      consider(
        plantKey(item.plantName, item.containerSize),
        item.unitCost || 0,
        doc.documentDate || doc.createdAt
      );
    }
  }

  return map;
}

/**
 * Operating balance sheet from NurseryOS data:
 * cash (receipts − payments), AR, inventory at estimated cost, AP, sales tax payable.
 * Equity is the balancing figure (assets − liabilities).
 */
export function buildBalanceSheet(
  documents: CustomerDocument[],
  bills: VendorBill[],
  inventory: Array<{
    plantName: string;
    containerSize: string;
    quantityAvailable: number;
  }>,
  asOf = new Date()
): BalanceSheetReport {
  const ar = buildArAging(documents, asOf);
  const ap = buildApAging(bills, asOf);
  const cash = buildCashMovement(documents, bills, 'all', asOf);

  const costLookup = buildPlantCostLookup(documents, bills);
  let inventoryAtCost = 0;
  let inventoryValuedUnits = 0;
  let inventoryUnvaluedUnits = 0;
  for (const plant of inventory) {
    const qty = Math.max(0, plant.quantityAvailable || 0);
    if (qty <= 0) continue;
    const hit = costLookup.get(plantKey(plant.plantName, plant.containerSize));
    if (hit && hit.cost > 0) {
      inventoryAtCost += qty * hit.cost;
      inventoryValuedUnits += qty;
    } else {
      inventoryUnvaluedUnits += qty;
    }
  }

  let salesTaxPayable = 0;
  for (const doc of documents) {
    if (doc.type === 'invoice') salesTaxPayable += doc.salesTax || 0;
    else if (doc.type === 'credit_memo') salesTaxPayable -= Math.abs(doc.salesTax || 0);
  }

  const cashEstimated = cash.net;
  const accountsReceivable = ar.total;
  const accountsPayable = ap.total;
  const totalAssets = cashEstimated + accountsReceivable + inventoryAtCost;
  const totalLiabilities = accountsPayable + salesTaxPayable;
  const equity = totalAssets - totalLiabilities;
  const totalLiabilitiesAndEquity = totalLiabilities + equity;

  const notes: string[] = ['bs_operating'];
  notes.push('bs_cash');
  if (inventoryUnvaluedUnits > 0) notes.push('bs_inventory');
  notes.push('bs_tax');

  const lines: BalanceSheetLine[] = [
    { id: 'cash', section: 'assets', amount: cashEstimated },
    { id: 'ar', section: 'assets', amount: accountsReceivable },
    { id: 'inventory', section: 'assets', amount: inventoryAtCost },
    { id: 'total_assets', section: 'assets', amount: totalAssets },
    { id: 'ap', section: 'liabilities', amount: accountsPayable },
    { id: 'sales_tax', section: 'liabilities', amount: salesTaxPayable },
    { id: 'total_liabilities', section: 'liabilities', amount: totalLiabilities },
    { id: 'equity', section: 'equity', amount: equity },
    { id: 'total_liab_equity', section: 'equity', amount: totalLiabilitiesAndEquity }
  ];

  return {
    asOf: asOf.toISOString().slice(0, 10),
    cashEstimated,
    accountsReceivable,
    inventoryAtCost,
    inventoryValuedUnits,
    inventoryUnvaluedUnits,
    totalAssets,
    accountsPayable,
    salesTaxPayable,
    totalLiabilities,
    equity,
    totalLiabilitiesAndEquity,
    balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01,
    notes,
    lines
  };
}

export type CsvRow = Record<string, string | number>;

function csvEscape(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

export function rowsToCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))
  ].join('\n');
}

export function downloadCsv(filename: string, rows: CsvRow[]) {
  const blob = new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface SalesCustomerRow {
  customer: string;
  invoices: number;
  netSales: number;
  salesTax: number;
  total: number;
  balance: number;
}

export interface SalesByCustomerReport {
  periodLabel: string;
  basis: AccountingBasis;
  rows: SalesCustomerRow[];
  netSales: number;
  salesTax: number;
  balance: number;
}

export function buildSalesByCustomer(
  documents: CustomerDocument[],
  period: AccountingPeriod,
  now = new Date(),
  basis: AccountingBasis = 'accrual'
): SalesByCustomerReport {
  const { start, end, label } = periodBounds(period, now);
  const map = new Map<string, SalesCustomerRow>();

  function rowFor(name: string): SalesCustomerRow {
    const key = name || 'Unknown customer';
    const existing = map.get(key);
    if (existing) return existing;
    const created: SalesCustomerRow = {
      customer: key,
      invoices: 0,
      netSales: 0,
      salesTax: 0,
      total: 0,
      balance: 0
    };
    map.set(key, created);
    return created;
  }

  for (const doc of documents) {
    if (doc.type !== 'invoice' && doc.type !== 'credit_memo') continue;
    const row = rowFor(doc.customerName);
    if (doc.type === 'invoice') row.balance = roundMoney(row.balance + invoiceBalanceDue(doc));
    else row.balance = roundMoney(row.balance - Math.abs(doc.grandTotal || 0));

    const when =
      basis === 'cash' && doc.type === 'invoice'
        ? doc.paidAt || doc.documentDate || doc.createdAt
        : doc.documentDate || doc.createdAt;
    if (!inPeriod(when, start, end)) continue;
    const ratio = basis === 'cash' && doc.type === 'invoice' ? cashIncomeRatio(doc) : 1;
    if (ratio <= 0) continue;
    const parts = documentIncomeParts(doc);
    const net = (parts.subtotal - parts.discount + parts.freight) * ratio;
    const tax = parts.tax * ratio;
    row.invoices += 1;
    row.netSales = roundMoney(row.netSales + net);
    row.salesTax = roundMoney(row.salesTax + tax);
    row.total = roundMoney(row.netSales + row.salesTax);
  }

  const rows = [...map.values()]
    .filter((row) => row.invoices > 0 || Math.abs(row.balance) > 0.009)
    .sort((a, b) => b.netSales - a.netSales || a.customer.localeCompare(b.customer));

  return {
    periodLabel: label,
    basis,
    rows,
    netSales: roundMoney(rows.reduce((s, r) => s + r.netSales, 0)),
    salesTax: roundMoney(rows.reduce((s, r) => s + r.salesTax, 0)),
    balance: roundMoney(rows.reduce((s, r) => s + r.balance, 0))
  };
}

export interface LedgerTxn {
  date: string;
  type: string;
  num: string;
  name: string;
  account: string;
  amount: number;
}

export function buildTransactionList(
  documents: CustomerDocument[],
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date()
): { periodLabel: string; rows: LedgerTxn[] } {
  const { start, end, label } = periodBounds(period, now);
  const rows: LedgerTxn[] = [];

  for (const doc of documents) {
    if (doc.type !== 'invoice' && doc.type !== 'credit_memo') continue;
    const docDate = doc.documentDate || doc.createdAt;
    if (inPeriod(docDate, start, end)) {
      const sign = doc.type === 'credit_memo' ? -1 : 1;
      rows.push({
        date: String(docDate).slice(0, 10),
        type: doc.type === 'credit_memo' ? 'Credit memo' : 'Invoice',
        num: doc.documentNumber,
        name: doc.customerName,
        account: 'Accounts receivable',
        amount: roundMoney(Math.abs(doc.grandTotal || 0) * sign)
      });
    }
    if (doc.type === 'invoice') {
      const paid = invoiceAmountPaid(doc);
      const paidAt = doc.paidAt || doc.documentDate || doc.createdAt;
      if (paid > 0.009 && inPeriod(paidAt, start, end)) {
        rows.push({
          date: String(paidAt).slice(0, 10),
          type: 'Payment',
          num: doc.paymentReference || doc.documentNumber,
          name: doc.customerName,
          account: methodLabel(doc.paymentMethod),
          amount: roundMoney(paid)
        });
      }
    }
  }

  for (const bill of bills) {
    const billDate = bill.billDate || bill.createdAt;
    if (inPeriod(billDate, start, end)) {
      rows.push({
        date: String(billDate).slice(0, 10),
        type: 'Bill',
        num: bill.vendorInvoiceNumber || bill.billNumber,
        name: bill.vendorName,
        account: 'Accounts payable',
        amount: roundMoney(-(bill.grandTotal || 0))
      });
    }
    const paid = billAmountPaid(bill);
    const paidAt = bill.paidAt || bill.billDate || bill.createdAt;
    if (paid > 0.009 && inPeriod(paidAt, start, end)) {
      rows.push({
        date: String(paidAt).slice(0, 10),
        type: 'Bill payment',
        num: bill.paymentReference || bill.billNumber,
        name: bill.vendorName,
        account: methodLabel(bill.paymentMethod),
        amount: roundMoney(-paid)
      });
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type) || a.num.localeCompare(b.num));
  return { periodLabel: label, rows };
}

export interface OpenItemRow {
  name: string;
  num: string;
  date: string;
  due: string;
  bucket: AgingBucketId;
  total: number;
  paid: number;
  balance: number;
}

export function buildArOpenItems(documents: CustomerDocument[], asOf = new Date()): OpenItemRow[] {
  const rows: OpenItemRow[] = [];
  for (const doc of documents) {
    if (doc.type === 'credit_memo') {
      const credit = Math.abs(doc.grandTotal || 0);
      if (credit <= 0.009) continue;
      rows.push({
        name: doc.customerName || 'Unknown customer',
        num: doc.documentNumber,
        date: String(doc.documentDate || doc.createdAt).slice(0, 10),
        due: '',
        bucket: 'current',
        total: roundMoney(-credit),
        paid: 0,
        balance: roundMoney(-credit)
      });
      continue;
    }
    if (doc.type !== 'invoice') continue;
    const balance = invoiceBalanceDue(doc);
    if (balance <= 0.009) continue;
    const due = parseDate(doc.dueDate) || parseDate(doc.documentDate) || parseDate(doc.createdAt);
    rows.push({
      name: doc.customerName || 'Unknown customer',
      num: doc.documentNumber,
      date: String(doc.documentDate || doc.createdAt).slice(0, 10),
      due: doc.dueDate ? String(doc.dueDate).slice(0, 10) : '',
      bucket: due ? bucketForDays(daysPastDue(asOf, due)) : 'current',
      total: roundMoney(doc.grandTotal || 0),
      paid: roundMoney(invoiceAmountPaid(doc)),
      balance: roundMoney(balance)
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
}

export function buildApOpenItems(bills: VendorBill[], asOf = new Date()): OpenItemRow[] {
  const rows: OpenItemRow[] = [];
  for (const bill of bills) {
    const balance = billBalanceDue(bill);
    if (balance <= 0.009) continue;
    const due = parseDate(bill.dueDate) || parseDate(bill.billDate) || parseDate(bill.createdAt);
    rows.push({
      name: bill.vendorName || 'Unknown vendor',
      num: bill.vendorInvoiceNumber || bill.billNumber,
      date: String(bill.billDate || bill.createdAt).slice(0, 10),
      due: bill.dueDate ? String(bill.dueDate).slice(0, 10) : '',
      bucket: due ? bucketForDays(daysPastDue(asOf, due)) : 'current',
      total: roundMoney(bill.grandTotal || 0),
      paid: roundMoney(billAmountPaid(bill)),
      balance: roundMoney(balance)
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
}

export interface TrialBalanceRow {
  account: string;
  debit: number;
  credit: number;
}

export interface TrialBalanceReport {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/**
 * All-time operating accounts in debit/credit form.
 * Owner's equity is the amount that makes the trial balance tie to the balance sheet
 * after current earnings are left in the income and expense accounts.
 */
export function buildTrialBalance(
  documents: CustomerDocument[],
  bills: VendorBill[],
  inventory: Array<{ plantName: string; containerSize: string; quantityAvailable: number }>,
  asOf = new Date()
): TrialBalanceReport {
  const pnl = buildProfitAndLoss(documents, bills, 'all', asOf, 'accrual');
  const bs = buildBalanceSheet(documents, bills, inventory, asOf);
  const equityBeforeEarnings = roundMoney(bs.equity - pnl.netOperating);
  const rows: TrialBalanceRow[] = [];

  function debit(account: string, amount: number) {
    const n = roundMoney(amount);
    if (Math.abs(n) < 0.005) return;
    if (n > 0) rows.push({ account, debit: n, credit: 0 });
    else rows.push({ account, debit: 0, credit: roundMoney(-n) });
  }
  function credit(account: string, amount: number) {
    const n = roundMoney(amount);
    if (Math.abs(n) < 0.005) return;
    if (n > 0) rows.push({ account, debit: 0, credit: n });
    else rows.push({ account, debit: roundMoney(-n), credit: 0 });
  }

  debit('Cash', bs.cashEstimated);
  debit('Accounts receivable', bs.accountsReceivable);
  debit('Inventory', bs.inventoryAtCost);
  debit('Cost of goods sold', pnl.cogs);
  debit('Discounts', pnl.discounts);
  for (const expense of pnl.expensesByCategory) debit(expense.category, expense.amount);
  credit('Product sales', pnl.productSales);
  credit('Freight income', pnl.freightIncome);
  credit('Accounts payable', bs.accountsPayable);
  credit('Sales tax payable', bs.salesTaxPayable);
  credit("Owner's equity", equityBeforeEarnings);

  const totalDebit = roundMoney(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = roundMoney(rows.reduce((s, r) => s + r.credit, 0));
  return {
    asOf: asOf.toISOString().slice(0, 10),
    rows,
    totalDebit,
    totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 0.02
  };
}

export function exportProfitAndLossCsv(
  pnl: PlReport,
  labels: {
    period: string;
    grossRevenue: string;
    salesTax: string;
    netSales: string;
    freight: string;
    discounts: string;
    cogs: string;
    grossProfit: string;
    opEx: string;
    netOperating: string;
    category: string;
    amount: string;
    section: string;
    line: string;
  }
): CsvRow[] {
  const rows: CsvRow[] = [
    { [labels.section]: 'Period', [labels.line]: `${labels.period} · ${pnl.basis}`, [labels.amount]: '' },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.grossRevenue,
      [labels.amount]: pnl.productSales
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.discounts,
      [labels.amount]: Number((-pnl.discounts).toFixed(2))
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.freight,
      [labels.amount]: pnl.freightIncome
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.netSales,
      [labels.amount]: pnl.netSales
    },
    {
      [labels.section]: 'COGS',
      [labels.line]: labels.cogs,
      [labels.amount]: Number((-pnl.cogs).toFixed(2))
    },
    {
      [labels.section]: 'Profit',
      [labels.line]: labels.grossProfit,
      [labels.amount]: pnl.grossProfit
    },
    {
      [labels.section]: 'Expenses',
      [labels.line]: labels.opEx,
      [labels.amount]: Number((-pnl.operatingExpenses).toFixed(2))
    },
    {
      [labels.section]: 'Profit',
      [labels.line]: labels.netOperating,
      [labels.amount]: pnl.netOperating
    },
    {
      [labels.section]: 'Liability — not income',
      [labels.line]: labels.salesTax,
      [labels.amount]: pnl.salesTax
    }
  ];
  for (const row of pnl.expensesByCategory) {
    rows.push({
      [labels.section]: 'Expense detail',
      [labels.line]: row.category,
      [labels.amount]: Number(row.amount.toFixed(2))
    });
  }
  return rows;
}

export function exportBalanceSheetCsv(
  bs: BalanceSheetReport,
  labels: {
    asOf: string;
    section: string;
    line: string;
    amount: string;
    cash: string;
    ar: string;
    inventory: string;
    totalAssets: string;
    ap: string;
    salesTax: string;
    totalLiabilities: string;
    equity: string;
    totalLiabEquity: string;
  }
): CsvRow[] {
  return [
    { [labels.section]: 'As of', [labels.line]: labels.asOf, [labels.amount]: '' },
    {
      [labels.section]: 'Assets',
      [labels.line]: labels.cash,
      [labels.amount]: Number(bs.cashEstimated.toFixed(2))
    },
    {
      [labels.section]: 'Assets',
      [labels.line]: labels.ar,
      [labels.amount]: Number(bs.accountsReceivable.toFixed(2))
    },
    {
      [labels.section]: 'Assets',
      [labels.line]: labels.inventory,
      [labels.amount]: Number(bs.inventoryAtCost.toFixed(2))
    },
    {
      [labels.section]: 'Assets',
      [labels.line]: labels.totalAssets,
      [labels.amount]: Number(bs.totalAssets.toFixed(2))
    },
    {
      [labels.section]: 'Liabilities',
      [labels.line]: labels.ap,
      [labels.amount]: Number(bs.accountsPayable.toFixed(2))
    },
    {
      [labels.section]: 'Liabilities',
      [labels.line]: labels.salesTax,
      [labels.amount]: Number(bs.salesTaxPayable.toFixed(2))
    },
    {
      [labels.section]: 'Liabilities',
      [labels.line]: labels.totalLiabilities,
      [labels.amount]: Number(bs.totalLiabilities.toFixed(2))
    },
    {
      [labels.section]: 'Equity',
      [labels.line]: labels.equity,
      [labels.amount]: Number(bs.equity.toFixed(2))
    },
    {
      [labels.section]: 'Equity',
      [labels.line]: labels.totalLiabEquity,
      [labels.amount]: Number(bs.totalLiabilitiesAndEquity.toFixed(2))
    }
  ];
}
