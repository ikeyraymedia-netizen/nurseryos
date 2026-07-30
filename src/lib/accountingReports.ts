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
    if (doc.type !== 'invoice') continue;
    salesTaxPayable += doc.salesTax || 0;
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
    { [labels.section]: 'Period', [labels.line]: labels.period, [labels.amount]: '' },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.grossRevenue,
      [labels.amount]: Number(pnl.revenue.toFixed(2))
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.salesTax,
      [labels.amount]: Number((-pnl.salesTax).toFixed(2))
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.netSales,
      [labels.amount]: Number((pnl.revenue - pnl.salesTax).toFixed(2))
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.freight,
      [labels.amount]: Number(pnl.freightIncome.toFixed(2))
    },
    {
      [labels.section]: 'Income',
      [labels.line]: labels.discounts,
      [labels.amount]: Number((-pnl.discounts).toFixed(2))
    },
    {
      [labels.section]: 'COGS',
      [labels.line]: labels.cogs,
      [labels.amount]: Number((-pnl.cogs).toFixed(2))
    },
    {
      [labels.section]: 'Profit',
      [labels.line]: labels.grossProfit,
      [labels.amount]: Number(pnl.grossProfit.toFixed(2))
    },
    {
      [labels.section]: 'Expenses',
      [labels.line]: labels.opEx,
      [labels.amount]: Number((-pnl.operatingExpenses).toFixed(2))
    },
    {
      [labels.section]: 'Profit',
      [labels.line]: labels.netOperating,
      [labels.amount]: Number(pnl.netOperating.toFixed(2))
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
