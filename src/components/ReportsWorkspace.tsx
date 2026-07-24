import { FormEvent, useEffect, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  Send,
  AlertCircle,
  Sparkles,
  Copy,
  Check,
  History
} from 'lucide-react';
import { Customer, CustomerOrder, Truck, InventoryPlant, CustomerDocument } from '../types';
import { AppPermissions } from '../lib/permissions';
import { subscribeToInventory } from '../lib/inventory';
import { listAllDocuments } from '../lib/documents';
import { AuditEvent, listRecentAuditEvents } from '../lib/audit';

interface ReportsWorkspaceProps {
  orders: CustomerOrder[];
  trucks: Truck[];
  customers: Customer[];
  permissions: AppPermissions;
  nurseryName: string;
}

const SUGGESTED_REPORTS = [
  'Sales for this month from saved invoices.',
  'Total sales from all saved invoices (grand totals).',
  'Sales by customer from saved invoices, ranked highest to lowest.',
  'List every saved invoice with date, customer, and amount.',
  'Compare estimates vs invoices: counts and dollar totals.',
  'Top-selling plants by dollars from saved invoices.',
  'Which orders are pending or still loading?',
  'Show inventory items that are low on stock (under 10 on hand).',
  'Summarize truck loading progress and overweight risk.',
  'List plants pulled but not yet loaded on trucks.',
  'What needs attention this week for loading, inventory, and sales?'
];

function monthKeyFromDate(raw?: string | null): string | null {
  if (!raw) return null;
  const iso = String(raw).trim().match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function invoiceMonthKey(doc: CustomerDocument): string {
  return monthKeyFromDate(doc.documentDate) || monthKeyFromDate(doc.createdAt) || 'unknown';
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

interface ProfitByRepRow {
  rep: string;
  invoiceCount: number;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
}

/** Aggregate invoice profit per sales rep (owner). Cost comes from saved line unitCost. */
const NO_SALES_REP_LABEL = 'No sales rep';

function buildProfitByRep(
  documents: CustomerDocument[],
  orders: CustomerOrder[]
): ProfitByRepRow[] {
  const ownerByOrderId = new Map<string, string>();
  for (const o of orders) {
    if (o.owner) ownerByOrderId.set(o.id, o.owner);
  }
  const invoices = documents.filter((d) => d.type === 'invoice');
  const map = new Map<string, ProfitByRepRow>();
  for (const inv of invoices) {
    const rep =
      inv.owner?.trim() ||
      (inv.orderId ? ownerByOrderId.get(inv.orderId)?.trim() : undefined) ||
      NO_SALES_REP_LABEL;
    let revenue = 0;
    let cost = 0;
    for (const item of inv.items || []) {
      const qty = item.quantity || 0;
      revenue += qty * (item.unitPrice || 0);
      cost += qty * (item.unitCost || 0);
    }
    const row =
      map.get(rep) || { rep, invoiceCount: 0, revenue: 0, cost: 0, profit: 0, margin: 0 };
    row.invoiceCount += 1;
    row.revenue += revenue;
    row.cost += cost;
    map.set(rep, row);
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      profit: r.revenue - r.cost,
      margin: r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0
    }))
    .sort((a, b) => {
      // Keep "No sales rep" at the bottom; otherwise sort by profit.
      if (a.rep === NO_SALES_REP_LABEL && b.rep !== NO_SALES_REP_LABEL) return 1;
      if (b.rep === NO_SALES_REP_LABEL && a.rep !== NO_SALES_REP_LABEL) return -1;
      return b.profit - a.profit;
    });
}

function buildDataSnapshot(params: {
  orders: CustomerOrder[];
  trucks: Truck[];
  customers: Customer[];
  inventory: InventoryPlant[];
  documents: CustomerDocument[];
}) {
  const { orders, trucks, customers, inventory, documents } = params;

  const invoices = documents.filter((d) => d.type === 'invoice');
  const estimates = documents.filter((d) => d.type === 'estimate');
  const invoiceSalesTotal = invoices.reduce((s, d) => s + (d.grandTotal || 0), 0);
  const estimateTotal = estimates.reduce((s, d) => s + (d.grandTotal || 0), 0);

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthKey = shiftMonthKey(thisMonthKey, -1);

  const salesByCustomer = new Map<string, { customerName: string; invoiceCount: number; salesTotal: number }>();
  const salesByMonth = new Map<string, { month: string; label: string; invoiceCount: number; salesTotal: number }>();

  for (const inv of invoices) {
    const key = inv.customerId || inv.customerName;
    const row = salesByCustomer.get(key) || {
      customerName: inv.customerName,
      invoiceCount: 0,
      salesTotal: 0
    };
    row.invoiceCount += 1;
    row.salesTotal += inv.grandTotal || 0;
    salesByCustomer.set(key, row);

    const month = invoiceMonthKey(inv);
    const monthRow = salesByMonth.get(month) || {
      month,
      label: month === 'unknown' ? 'Unknown date' : monthLabel(month),
      invoiceCount: 0,
      salesTotal: 0
    };
    monthRow.invoiceCount += 1;
    monthRow.salesTotal += inv.grandTotal || 0;
    salesByMonth.set(month, monthRow);
  }

  const thisMonthRow = salesByMonth.get(thisMonthKey);
  const lastMonthRow = salesByMonth.get(lastMonthKey);

  const plantSales = new Map<
    string,
    { plantName: string; containerSize: string; qty: number; revenue: number }
  >();
  for (const inv of invoices) {
    for (const item of inv.items || []) {
      const key = `${item.plantName}||${item.containerSize}`;
      const row = plantSales.get(key) || {
        plantName: item.plantName,
        containerSize: item.containerSize,
        qty: 0,
        revenue: 0
      };
      row.qty += item.quantity || 0;
      row.revenue += (item.quantity || 0) * (item.unitPrice || 0);
      plantSales.set(key, row);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      orderCount: orders.length,
      truckCount: trucks.length,
      customerCount: customers.length,
      inventoryCount: inventory.length,
      documentCount: documents.length,
      invoiceCount: invoices.length,
      estimateCount: estimates.length,
      invoiceSalesTotal,
      estimateTotal,
      thisMonthSalesTotal: thisMonthRow?.salesTotal || 0,
      thisMonthInvoiceCount: thisMonthRow?.invoiceCount || 0,
      thisMonthKey,
      thisMonthLabel: monthLabel(thisMonthKey)
    },
    /** Pre-aggregated sales from saved invoices — prefer this for sales questions. */
    sales: {
      source: 'Saved invoices (CustomerDocument type=invoice). Estimates are not counted as sales.',
      dateRule:
        'Invoice month uses documentDate (YYYY-MM-DD). If missing, uses createdAt. Periods are local calendar months.',
      today: now.toISOString().slice(0, 10),
      thisMonth: {
        month: thisMonthKey,
        label: monthLabel(thisMonthKey),
        invoiceCount: thisMonthRow?.invoiceCount || 0,
        salesTotal: thisMonthRow?.salesTotal || 0
      },
      lastMonth: {
        month: lastMonthKey,
        label: monthLabel(lastMonthKey),
        invoiceCount: lastMonthRow?.invoiceCount || 0,
        salesTotal: lastMonthRow?.salesTotal || 0
      },
      invoiceSalesTotal,
      estimateTotal,
      invoiceCount: invoices.length,
      estimateCount: estimates.length,
      byMonth: [...salesByMonth.values()].sort((a, b) => b.month.localeCompare(a.month)),
      byCustomer: [...salesByCustomer.values()]
        .sort((a, b) => b.salesTotal - a.salesTotal)
        .slice(0, 100),
      topPlantsByRevenue: [...plantSales.values()]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 50),
      profitByRep: buildProfitByRep(documents, orders)
    },
    orders: orders.slice(0, 200).map((o) => ({
      id: o.id,
      customerName: o.customerName,
      customerId: o.customerId || null,
      orderNumber: o.orderNumber,
      status: o.status,
      dateCreated: o.dateCreated,
      truckId: o.truckId || null,
      totalWeightLbs: o.totalWeightLbs,
      itemCount: o.items.length,
      totalQty: o.items.reduce((s, i) => s + i.quantity, 0),
      loadedQty: o.items.reduce((s, i) => s + i.loadedQuantity, 0),
      pulledQty: o.items.reduce((s, i) => s + (i.pulledQuantity ?? 0), 0),
      items: o.items.slice(0, 40).map((i) => ({
        plantName: i.plantName,
        containerSize: i.containerSize,
        quantity: i.quantity,
        loadedQuantity: i.loadedQuantity,
        pulledQuantity: i.pulledQuantity ?? 0,
        unitPrice: i.unitPrice ?? null
      }))
    })),
    trucks: trucks.slice(0, 100).map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      truckType: t.truckType || null,
      loadingDate: t.loadingDate || null,
      orderIds: t.orderIds,
      carrier: t.carrier || null,
      owner: t.owner || null
    })),
    customers: customers.slice(0, 200).map((c) => ({
      id: c.id,
      name: c.name,
      contactEmail: c.contactEmail || null,
      paymentTerms: c.paymentTerms || null
    })),
    inventory: inventory.slice(0, 400).map((p) => ({
      plantName: p.plantName,
      containerSize: p.containerSize,
      quantityAvailable: p.quantityAvailable,
      location: p.location || null,
      weeksUntilReady: p.weeksUntilReady ?? null
    })),
    invoices: invoices.slice(0, 200).map((d) => ({
      documentNumber: d.documentNumber,
      customerName: d.customerName,
      customerId: d.customerId,
      documentDate: d.documentDate,
      month: invoiceMonthKey(d),
      createdAt: d.createdAt || null,
      dueDate: d.dueDate || null,
      orderNumber: d.orderNumber || null,
      subtotal: d.subtotal,
      salesTax: d.salesTax,
      freightCharge: d.freightCharge ?? 0,
      discount: d.discount ?? 0,
      grandTotal: d.grandTotal,
      owner: d.owner || null,
      lineItems: (d.items || []).slice(0, 40).map((i) => ({
        plantName: i.plantName,
        containerSize: i.containerSize,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        unitCost: i.unitCost ?? null,
        lineTotal: (i.quantity || 0) * (i.unitPrice || 0)
      }))
    })),
    estimates: estimates.slice(0, 100).map((d) => ({
      documentNumber: d.documentNumber,
      customerName: d.customerName,
      documentDate: d.documentDate,
      month: invoiceMonthKey(d),
      orderNumber: d.orderNumber || null,
      grandTotal: d.grandTotal
    }))
  };
}

export function ReportsWorkspace({
  orders,
  trucks,
  customers,
  permissions,
  nurseryName
}: ReportsWorkspaceProps) {
  const [inventory, setInventory] = useState<InventoryPlant[]>([]);
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    if (!permissions.canViewInventory) {
      setInventory([]);
      return;
    }
    return subscribeToInventory(setInventory);
  }, [permissions.canViewInventory]);

  async function refreshDocuments() {
    try {
      const docs = await listAllDocuments();
      setDocuments(docs);
      setDocsError(null);
      return docs;
    } catch (err: any) {
      setDocuments([]);
      setDocsError(err?.message || 'Could not load saved invoices/estimates.');
      return [] as CustomerDocument[];
    }
  }

  async function refreshAudit() {
    try {
      const events = await listRecentAuditEvents(25);
      setAuditEvents(events);
      setAuditError(null);
    } catch (err: any) {
      setAuditEvents([]);
      setAuditError(err?.message || 'Could not load activity log.');
    }
  }

  useEffect(() => {
    void refreshDocuments();
    void refreshAudit();
  }, []);

  const invoiceCount = documents.filter((d) => d.type === 'invoice').length;
  const estimateCount = documents.filter((d) => d.type === 'estimate').length;
  const profitByRep = buildProfitByRep(documents, orders);
  const money = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const salesPreview = buildDataSnapshot({
    orders,
    trucks,
    customers,
    inventory,
    documents
  }).sales;

  if (!permissions.canViewReports) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-gray-500">
        Reports are available to owners, admins, and office staff.
      </div>
    );
  }

  async function runReport(promptText: string) {
    const trimmed = promptText.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setReport(null);
    setLastQuestion(trimmed);
    setCopied(false);

    try {
      const freshDocuments = await refreshDocuments();
      const data = buildDataSnapshot({
        orders,
        trucks,
        customers,
        inventory,
        documents: freshDocuments
      });

      const response = await fetch('/api/run-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          nurseryName,
          data
        })
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const details =
          typeof result.details === 'string' && result.details.trim()
            ? ` ${result.details}`
            : '';
        throw new Error(`${result.error || 'Failed to run report.'}${details}`);
      }

      setReport(result.report || 'No report returned.');
    } catch (err: any) {
      setError(err?.message || 'Failed to run report.');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runReport(question);
  }

  async function handleCopy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[520px]">
      <div className="bg-slate-900 text-white px-5 py-4 flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
          <BarChart3 className="h-5 w-5 text-emerald-300" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-black tracking-tight">Reports</h2>
          <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
            Ask AI about loading, inventory, customers, and sales. Sales numbers come from invoices
            you saved under a customer (Create Invoice → Save to Customer).
          </p>
        </div>
      </div>

      <div className="p-5 space-y-4 flex-1 flex flex-col">
        <div className="text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2 leading-relaxed space-y-1">
          <p>
            <span className="font-bold">Sales data loaded:</span> {invoiceCount} invoice
            {invoiceCount === 1 ? '' : 's'} · {estimateCount} estimate
            {estimateCount === 1 ? '' : 's'} ·{' '}
            <span className="font-bold">
              {salesPreview.thisMonth.label}: ${salesPreview.thisMonth.salesTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            {' '}({salesPreview.thisMonth.invoiceCount} invoice
            {salesPreview.thisMonth.invoiceCount === 1 ? '' : 's'}) · All-time invoices: $
            {salesPreview.invoiceSalesTotal.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}
          </p>
          <p>
            <span className="font-bold">Sales tip:</span> Only invoices saved under a customer count
            (Create Invoice → Save to Customer). Estimates are not sales. Month uses the invoice date.
          </p>
          {docsError && (
            <p className="text-red-700 font-semibold">Could not load documents: {docsError}</p>
          )}
          {!docsError && invoiceCount === 0 && (
            <p className="text-amber-800 font-semibold">
              No saved invoices yet — “sales this month” will be $0 until you save at least one invoice.
            </p>
          )}
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-emerald-700" />
            Suggested reports
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_REPORTS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={loading}
                onClick={() => {
                  setQuestion(suggestion);
                  void runReport(suggestion);
                }}
                className="text-left text-[11px] font-semibold px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:border-emerald-300 hover:bg-emerald-50 text-gray-700 disabled:opacity-50 transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500">
            Or type your own report request
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder='e.g. "Total sales this month" or "Sales by customer from invoices"'
              className="flex-1 w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-white resize-y min-h-[84px]"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="sm:self-stretch inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-black disabled:opacity-50 shrink-0"
            >
              {loading ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Run report
                </>
              )}
            </button>
          </div>
        </form>

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}

        {(report || loading) && (
          <div className="flex-1 border border-slate-200 rounded-2xl bg-slate-50/60 overflow-hidden flex flex-col min-h-[240px]">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 bg-white">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  Report result
                </p>
                {lastQuestion && (
                  <p className="text-xs font-semibold text-gray-800 truncate">{lastQuestion}</p>
                )}
              </div>
              {report && (
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 text-[11px] font-bold text-gray-600 hover:bg-gray-50 shrink-0"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </>
                  )}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <RefreshCw className="h-7 w-7 text-emerald-700 animate-spin mb-3" />
                  <p className="text-sm font-bold text-gray-800">Analyzing nursery data…</p>
                  <p className="text-xs text-gray-500 mt-1 max-w-sm">
                    AI is reading your orders, trucks, inventory, and documents.
                  </p>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 leading-relaxed">
                  {report}
                </pre>
              )}
            </div>
          </div>
        )}

        {!report && !loading && !error && (
          <div className="flex-1 rounded-2xl border border-dashed border-slate-200 bg-slate-50/40 flex items-center justify-center p-8 text-center">
            <div>
              <BarChart3 className="h-8 w-8 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-bold text-gray-700">Pick a suggested report or ask your own</p>
              <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto leading-relaxed">
                Examples: low stock, unfinished loads, invoice totals, or customer activity.
              </p>
            </div>
          </div>
        )}

        {permissions.canViewProfit && (
          <div className="border border-indigo-200 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-indigo-200 bg-indigo-50/60">
              <div className="flex items-center gap-2 min-w-0">
                <BarChart3 className="h-4 w-4 text-indigo-700 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-indigo-400">
                    Profit by sales rep
                  </p>
                  <p className="text-xs font-semibold text-gray-800 truncate">
                    From saved invoices (revenue − cost)
                  </p>
                </div>
              </div>
              <span className="text-[10px] font-bold uppercase text-indigo-400 tracking-wide shrink-0">
                Internal only
              </span>
            </div>
            {profitByRep.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-500">
                No invoice data yet. Set a Sales Rep on orders/invoices and enter plant costs to see
                profit per rep here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-gray-400 border-b border-slate-200 bg-white">
                      <th className="text-left font-bold px-4 py-2">Sales Rep</th>
                      <th className="text-right font-bold px-3 py-2">Invoices</th>
                      <th className="text-right font-bold px-3 py-2">Revenue</th>
                      <th className="text-right font-bold px-3 py-2">Cost</th>
                      <th className="text-right font-bold px-3 py-2">Profit</th>
                      <th className="text-right font-bold px-4 py-2">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {profitByRep.map((row) => (
                      <tr
                        key={row.rep}
                        className={
                          row.rep === NO_SALES_REP_LABEL ? 'bg-slate-50' : 'bg-white'
                        }
                      >
                        <td
                          className={`text-left font-bold px-4 py-2 ${
                            row.rep === NO_SALES_REP_LABEL
                              ? 'text-slate-500 italic'
                              : 'text-gray-900'
                          }`}
                        >
                          {row.rep}
                        </td>
                        <td className="text-right font-mono text-gray-700 px-3 py-2">
                          {row.invoiceCount}
                        </td>
                        <td className="text-right font-mono text-gray-700 px-3 py-2">
                          {money(row.revenue)}
                        </td>
                        <td className="text-right font-mono text-gray-700 px-3 py-2">
                          {money(row.cost)}
                        </td>
                        <td
                          className={`text-right font-mono font-black px-3 py-2 ${
                            row.profit >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }`}
                        >
                          {money(row.profit)}
                        </td>
                        <td className="text-right font-mono text-gray-500 px-4 py-2">
                          {row.margin.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 py-2.5 text-[10px] text-slate-500 leading-relaxed border-t border-slate-100 bg-slate-50/60">
                  Names come from the Sales Rep saved on each invoice (or its order). Older invoices may
                  still say &quot;Ikey&quot; / &quot;Nathan&quot; / &quot;Michael&quot; from the previous list — open those
                  invoices and pick the current team member to update. &quot;No sales rep&quot; means none was set.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="border border-slate-200 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 bg-white">
            <div className="flex items-center gap-2 min-w-0">
              <History className="h-4 w-4 text-emerald-700 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Recent activity</p>
                <p className="text-xs font-semibold text-gray-800 truncate">Key saves and conversions</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refreshAudit()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 text-[11px] font-bold text-gray-600 hover:bg-gray-50 shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 bg-slate-50/40">
            {auditError ? (
              <p className="px-4 py-3 text-xs text-amber-800">
                {auditError} Publish the latest firestore.rules (auditLog) if this persists.
              </p>
            ) : auditEvents.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-500">
                No activity yet. Saving invoices, estimates, uploads, or backups will show up here.
              </p>
            ) : (
              auditEvents.map((event) => (
                <div key={event.id || `${event.action}-${event.createdAt}`} className="px-4 py-2.5">
                  <p className="text-xs font-semibold text-gray-900">{event.summary}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
                    {event.action} · {new Date(event.createdAt).toLocaleString()}
                    {event.actorEmail ? ` · ${event.actorEmail}` : ''}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
