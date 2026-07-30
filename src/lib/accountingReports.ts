import { CustomerDocument, VendorBill } from '../types';
import { purchaseCategoryLabel, isPlantPurchaseCategory } from './purchaseCategories';

export type AccountingPeriod = 'month' | 'quarter' | 'year' | 'all';

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
  revenue: number;
  salesTax: number;
  freightIncome: number;
  discounts: number;
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

export interface SalesTaxReport {
  periodLabel: string;
  taxableSales: number;
  salesTaxCollected: number;
  invoiceCount: number;
  byRate: Array<{ ratePct: number; taxable: number; tax: number; invoiceCount: number }>;
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
  total: number;
  byCategory: Array<{ category: string; amount: number; count: number }>;
  byVendor: Array<{ vendor: string; amount: number; count: number }>;
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
    if (doc.type !== 'invoice') continue;
    const status = doc.paymentStatus || 'unpaid';
    if (status === 'paid') continue;
    const amount = doc.grandTotal || 0;
    if (amount <= 0) continue;
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

  return finalizeAging(asOf, totals, rowMap);
}

/** Open vendor bills aged by due date (falls back to bill date). */
export function buildApAging(bills: VendorBill[], asOf = new Date()): AgingReport {
  const totals = emptyBuckets();
  const rowMap = new Map<string, AgingRow>();

  for (const bill of bills) {
    if (bill.status === 'paid') continue;
    const amount = bill.grandTotal || 0;
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

export function buildProfitAndLoss(
  documents: CustomerDocument[],
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date()
): PlReport {
  const { start, end, label } = periodBounds(period, now);
  let revenue = 0;
  let salesTax = 0;
  let freightIncome = 0;
  let discounts = 0;
  let cogsFromInvoices = 0;
  let invoiceCount = 0;

  for (const doc of documents) {
    if (doc.type !== 'invoice') continue;
    if (!inPeriod(doc.documentDate || doc.createdAt, start, end)) continue;
    invoiceCount += 1;
    revenue += doc.grandTotal || 0;
    salesTax += doc.salesTax || 0;
    freightIncome += doc.freightCharge || 0;
    discounts += doc.discount || 0;
    cogsFromInvoices += invoiceCogs(doc);
  }

  let cogsFromVendorPlants = 0;
  let operatingExpenses = 0;
  let billCount = 0;
  const expenseMap = new Map<string, number>();

  for (const bill of bills) {
    if (!inPeriod(bill.billDate || bill.createdAt, start, end)) continue;
    billCount += 1;
    const lines = bill.items || [];
    if (lines.length === 0) {
      const amt = bill.grandTotal || 0;
      operatingExpenses += amt;
      expenseMap.set('Other', (expenseMap.get('Other') || 0) + amt);
      continue;
    }
    for (const line of lines) {
      const amt = (line.quantity || 0) * (line.unitCost || 0);
      const category = purchaseCategoryLabel(
        line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
      );
      if (isPlantPurchaseCategory(category)) {
        cogsFromVendorPlants += amt;
      } else {
        operatingExpenses += amt;
        expenseMap.set(category, (expenseMap.get(category) || 0) + amt);
      }
    }
    if (bill.freightCharge) {
      operatingExpenses += bill.freightCharge;
      expenseMap.set('Freight', (expenseMap.get('Freight') || 0) + bill.freightCharge);
    }
  }

  // Prefer invoice line costs when present; otherwise fall back to plant vendor bills.
  const cogs = cogsFromInvoices > 0 ? cogsFromInvoices : cogsFromVendorPlants;
  const grossProfit = revenue - salesTax - cogs;
  const grossMarginPct = revenue - salesTax > 0 ? (grossProfit / (revenue - salesTax)) * 100 : 0;
  const netOperating = grossProfit - operatingExpenses;

  const notes: string[] = [];
  if (cogsFromInvoices <= 0 && cogsFromVendorPlants > 0) {
    notes.push('cogs_bills');
  } else if (cogsFromInvoices <= 0) {
    notes.push('cogs_empty');
  }
  notes.push('gaap');

  return {
    periodLabel: label,
    revenue,
    salesTax,
    freightIncome,
    discounts,
    cogsFromInvoices,
    cogsFromVendorPlants,
    cogs,
    grossProfit,
    grossMarginPct,
    operatingExpenses,
    expensesByCategory: [...expenseMap.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    netOperating,
    invoiceCount,
    billCount,
    notes
  };
}

export function buildSalesTaxReport(
  documents: CustomerDocument[],
  period: AccountingPeriod,
  now = new Date()
): SalesTaxReport {
  const { start, end, label } = periodBounds(period, now);
  let taxableSales = 0;
  let salesTaxCollected = 0;
  let invoiceCount = 0;
  const byRate = new Map<number, { taxable: number; tax: number; invoiceCount: number }>();

  for (const doc of documents) {
    if (doc.type !== 'invoice') continue;
    if (!inPeriod(doc.documentDate || doc.createdAt, start, end)) continue;
    invoiceCount += 1;
    const tax = doc.salesTax || 0;
    const rate = doc.taxRate || 0;
    const taxable = Math.max(0, (doc.subtotal || 0) - (doc.discount || 0));
    taxableSales += taxable;
    salesTaxCollected += tax;
    const row = byRate.get(rate) || { taxable: 0, tax: 0, invoiceCount: 0 };
    row.taxable += taxable;
    row.tax += tax;
    row.invoiceCount += 1;
    byRate.set(rate, row);
  }

  return {
    periodLabel: label,
    taxableSales,
    salesTaxCollected,
    invoiceCount,
    byRate: [...byRate.entries()]
      .map(([ratePct, row]) => ({ ratePct, ...row }))
      .sort((a, b) => b.tax - a.tax)
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
    if ((doc.paymentStatus || 'unpaid') !== 'paid') continue;
    const paidRaw = doc.paidAt || doc.documentDate || doc.createdAt;
    if (!inPeriod(paidRaw, start, end)) continue;
    const amount =
      doc.stripePaidAmountCents != null
        ? doc.stripePaidAmountCents / 100
        : doc.grandTotal || 0;
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
    if (bill.status !== 'paid') continue;
    const paidRaw = bill.paidAt || bill.billDate || bill.createdAt;
    if (!inPeriod(paidRaw, start, end)) continue;
    const amount = bill.grandTotal || 0;
    if (amount <= 0) continue;
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
    inRows: inRows.slice(0, 50),
    outRows: outRows.slice(0, 50)
  };
}

export function buildExpenseReport(
  bills: VendorBill[],
  period: AccountingPeriod,
  now = new Date()
): ExpenseReport {
  const { start, end, label } = periodBounds(period, now);
  const byCategory = new Map<string, { amount: number; count: number }>();
  const byVendor = new Map<string, { amount: number; count: number }>();
  let total = 0;

  for (const bill of bills) {
    if (!inPeriod(bill.billDate || bill.createdAt, start, end)) continue;
    const billTotal = bill.grandTotal || billLineTotal(bill);
    total += billTotal;
    const vendor = bill.vendorName || 'Unknown vendor';
    const v = byVendor.get(vendor) || { amount: 0, count: 0 };
    v.amount += billTotal;
    v.count += 1;
    byVendor.set(vendor, v);

    const lines = bill.items || [];
    if (lines.length === 0) {
      const c = byCategory.get('Other') || { amount: 0, count: 0 };
      c.amount += billTotal;
      c.count += 1;
      byCategory.set('Other', c);
      continue;
    }
    for (const line of lines) {
      const amt = (line.quantity || 0) * (line.unitCost || 0);
      const category = purchaseCategoryLabel(
        line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
      );
      const c = byCategory.get(category) || { amount: 0, count: 0 };
      c.amount += amt;
      c.count += 1;
      byCategory.set(category, c);
    }
    if (bill.freightCharge) {
      const c = byCategory.get('Freight') || { amount: 0, count: 0 };
      c.amount += bill.freightCharge;
      c.count += 1;
      byCategory.set('Freight', c);
    }
  }

  return {
    periodLabel: label,
    total,
    byCategory: [...byCategory.entries()]
      .map(([category, row]) => ({ category, ...row }))
      .sort((a, b) => b.amount - a.amount),
    byVendor: [...byVendor.entries()]
      .map(([vendor, row]) => ({ vendor, ...row }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 25)
  };
}
