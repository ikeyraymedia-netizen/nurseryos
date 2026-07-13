import { FormEvent, useEffect, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  Send,
  AlertCircle,
  Sparkles,
  Copy,
  Check
} from 'lucide-react';
import { Customer, CustomerOrder, Truck, InventoryPlant, CustomerDocument } from '../types';
import { AppPermissions } from '../lib/permissions';
import { subscribeToInventory } from '../lib/inventory';
import { listAllDocuments } from '../lib/documents';

interface ReportsWorkspaceProps {
  orders: CustomerOrder[];
  trucks: Truck[];
  customers: Customer[];
  permissions: AppPermissions;
  nurseryName: string;
}

const SUGGESTED_REPORTS = [
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

  const salesByCustomer = new Map<string, { customerName: string; invoiceCount: number; salesTotal: number }>();
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
  }

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
      estimateTotal
    },
    /** Pre-aggregated sales from saved invoices — prefer this for sales questions. */
    sales: {
      source: 'Saved invoices (CustomerDocument type=invoice). Estimates are not counted as sales.',
      invoiceSalesTotal,
      estimateTotal,
      invoiceCount: invoices.length,
      estimateCount: estimates.length,
      byCustomer: [...salesByCustomer.values()]
        .sort((a, b) => b.salesTotal - a.salesTotal)
        .slice(0, 100),
      topPlantsByRevenue: [...plantSales.values()]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 50)
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
      dueDate: d.dueDate || null,
      orderNumber: d.orderNumber || null,
      subtotal: d.subtotal,
      salesTax: d.salesTax,
      freightCharge: d.freightCharge ?? 0,
      discount: d.discount ?? 0,
      grandTotal: d.grandTotal,
      lineItems: (d.items || []).slice(0, 40).map((i) => ({
        plantName: i.plantName,
        containerSize: i.containerSize,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: (i.quantity || 0) * (i.unitPrice || 0)
      }))
    })),
    estimates: estimates.slice(0, 100).map((d) => ({
      documentNumber: d.documentNumber,
      customerName: d.customerName,
      documentDate: d.documentDate,
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
  const [question, setQuestion] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeToInventory(setInventory), []);

  useEffect(() => {
    let active = true;
    listAllDocuments()
      .then((docs) => {
        if (active) setDocuments(docs);
      })
      .catch(() => {
        if (active) setDocuments([]);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!permissions.canViewReports) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-gray-500">
        Reports are available to owners and admins only.
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
      const data = buildDataSnapshot({
        orders,
        trucks,
        customers,
        inventory,
        documents
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
        <div className="text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2 leading-relaxed">
          <span className="font-bold">Sales tip:</span> Save invoices from an order to include them in
          sales reports. Estimates are tracked separately and are not counted as sales.
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
      </div>
    </div>
  );
}
