import { Type } from '@google/genai';

/** Compact nursery records sent by the Reports screen; tools run exact math over these. */
export interface ReportLedger {
  documents?: LedgerDocument[];
  orders?: LedgerOrder[];
  inventory?: LedgerInventory[];
  vendorBills?: LedgerVendorBill[];
  trucks?: LedgerTruck[];
}

interface LedgerLine {
  plant: string;
  size: string;
  qty: number;
  price?: number | null;
  cost?: number | null;
  vendor?: string | null;
}

interface LedgerDocument {
  type: 'invoice' | 'credit_memo' | 'estimate';
  number: string;
  customer: string;
  date: string;
  dueDate?: string | null;
  rep?: string | null;
  paymentStatus?: string | null;
  paidAt?: string | null;
  orderNumber?: string | null;
  poNumber?: string | null;
  subtotal: number;
  tax: number;
  freight: number;
  discount: number;
  total: number;
  lines: LedgerLine[];
}

interface LedgerOrderItem extends LedgerLine {
  loaded: number;
  pulled: number;
  invoiced?: number;
  notes?: string | null;
  isAddition?: boolean;
}

interface LedgerOrder {
  orderNumber: string;
  customer: string;
  date: string;
  status: string;
  rep?: string | null;
  truck?: string | null;
  loadingDate?: string | null;
  directShip?: boolean;
  items: LedgerOrderItem[];
}

interface LedgerInventory {
  plant: string;
  size: string;
  qty: number;
  listPrice?: number | null;
  category?: string | null;
  location?: string | null;
  readyDate?: string | null;
  plantedDate?: string | null;
  source?: string | null;
}

interface LedgerVendorBill {
  vendor: string;
  billNumber: string;
  vendorInvoiceNumber?: string | null;
  date: string;
  dueDate?: string | null;
  status: string;
  paidAt?: string | null;
  paymentMethod?: string | null;
  total: number;
  lines: Array<{ item: string; size: string; qty: number; unitCost: number; category?: string | null }>;
}

interface LedgerTruck {
  name: string;
  status: string;
  loadingDate?: string | null;
  carrier?: string | null;
  rep?: string | null;
  orderNumbers: string[];
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function tokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9#&\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Every word of the filter appears in the value ("siteone baton" matches "SiteOne - Baton Rouge"). */
function textMatches(value: string | null | undefined, filter: unknown): boolean {
  const wanted = tokens(String(filter ?? ''));
  if (wanted.length === 0) return true;
  const hay = String(value || '').toLowerCase().replace(/[^a-z0-9#&\s]/g, ' ');
  return wanted.every((w) => hay.includes(w));
}

function normSize(size: string): string {
  const s = String(size || '').toLowerCase().replace(/\s+/g, '');
  const gal = s.match(/^#?(\d+)(g|gal|gallon)?$/);
  if (gal) return `#${gal[1]}`;
  if (s === 'flat' || s === 'flats' || s === 'trays') return 'tray';
  return s;
}

function sizeMatches(value: string, filter: unknown): boolean {
  if (filter == null || String(filter).trim() === '') return true;
  return normSize(value) === normSize(String(filter));
}

function inRange(date: string | null | undefined, from: unknown, to: unknown): boolean {
  const day = String(date || '').slice(0, 10);
  if (from && (!day || day < String(from))) return false;
  if (to && (!day || day > String(to))) return false;
  return true;
}

function limitOf(args: Record<string, any>): number {
  const n = Number(args.limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function weekKey(date: string): string {
  const day = String(date || '').slice(0, 10);
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'unknown';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  dt.setDate(dt.getDate() - dt.getDay());
  return `week of ${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function periodKey(date: string, groupBy: string): string {
  const day = String(date || '').slice(0, 10);
  if (!day) return 'unknown';
  if (groupBy === 'month') return day.slice(0, 7);
  if (groupBy === 'year') return day.slice(0, 4);
  if (groupBy === 'week') return weekKey(day);
  return day;
}

function distinctMatches<T>(items: T[], get: (item: T) => string | null | undefined): string[] {
  return [...new Set(items.map((i) => String(get(i) || '').trim()).filter(Boolean))].slice(0, 15);
}

type Bucket = {
  key: string;
  documents: Set<string>;
  qty: number;
  revenue: number;
  cost: number;
  costKnownRevenue: number;
  total: number;
};

function bucketRow(b: Bucket) {
  const profit = b.costKnownRevenue - b.cost;
  return {
    key: b.key,
    documentCount: b.documents.size,
    qty: round2(b.qty),
    merchandiseRevenue: round2(b.revenue),
    documentTotal: round2(b.total),
    cost: round2(b.cost),
    profit: round2(profit),
    marginPct: b.costKnownRevenue > 0 ? round2((profit / b.costKnownRevenue) * 100) : null
  };
}

function sortRows(rows: ReturnType<typeof bucketRow>[], sortBy: string) {
  const by = sortBy || 'revenue';
  return rows.sort((a, b) => {
    if (by === 'key') return a.key.localeCompare(b.key);
    if (by === 'qty') return b.qty - a.qty;
    if (by === 'profit') return b.profit - a.profit;
    if (by === 'count') return b.documentCount - a.documentCount;
    if (by === 'total') return b.documentTotal - a.documentTotal;
    return b.merchandiseRevenue - a.merchandiseRevenue || b.documentTotal - a.documentTotal;
  });
}

function filterDocuments(ledger: ReportLedger, args: Record<string, any>): LedgerDocument[] {
  const types: string[] =
    Array.isArray(args.documentTypes) && args.documentTypes.length > 0
      ? args.documentTypes
      : ['invoice', 'credit_memo'];
  return (ledger.documents || []).filter(
    (d) =>
      types.includes(d.type) &&
      inRange(d.date, args.dateFrom, args.dateTo) &&
      textMatches(d.customer, args.customer) &&
      textMatches(d.rep || 'No sales rep', args.rep) &&
      (!args.paymentStatus || String(d.paymentStatus || 'unpaid') === String(args.paymentStatus)) &&
      (!args.documentNumber || textMatches(d.number, args.documentNumber))
  );
}

function lineMatches(line: LedgerLine, args: Record<string, any>): boolean {
  return (
    textMatches(line.plant, args.plant) &&
    sizeMatches(line.size, args.size) &&
    textMatches(line.vendor || '', args.vendor)
  );
}

function querySales(ledger: ReportLedger, args: Record<string, any>) {
  const docs = filterDocuments(ledger, args);
  const lineFilter = Boolean(args.plant || args.size || args.vendor);
  const groupBy = String(args.groupBy || 'none');
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, documents: new Set(), qty: 0, revenue: 0, cost: 0, costKnownRevenue: 0, total: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  const totals = bucket('__total__');
  buckets.delete('__total__');
  const matchedPlants = new Set<string>();
  const countedCustomers = new Set<string>();

  const docKey = (d: LedgerDocument): string | null => {
    switch (groupBy) {
      case 'customer':
        return d.customer || 'Unknown customer';
      case 'rep':
        return d.rep || 'No sales rep';
      case 'payment_status':
        return d.paymentStatus || 'unpaid';
      case 'document':
        return `${d.type === 'credit_memo' ? 'Credit memo' : d.type === 'estimate' ? 'Estimate' : 'Invoice'} ${d.number} · ${d.customer} · ${d.date}`;
      case 'day':
      case 'week':
      case 'month':
      case 'year':
        return periodKey(d.date, groupBy);
      case 'none':
        return 'all';
      default:
        return null;
    }
  };

  for (const d of docs) {
    const sign = d.type === 'credit_memo' ? -1 : 1;
    const docId = `${d.type}:${d.number}:${d.customer}`;
    let docMatched = !lineFilter;
    for (const line of d.lines || []) {
      if (lineFilter && !lineMatches(line, args)) continue;
      docMatched = true;
      matchedPlants.add(`${line.plant} ${line.size}`.trim());
      const qty = (Number(line.qty) || 0) * sign;
      const revenue = qty * (Number(line.price) || 0);
      const hasCost = line.cost != null && Number.isFinite(Number(line.cost));
      const cost = hasCost ? qty * Number(line.cost) : 0;
      const key =
        groupBy === 'plant'
          ? line.plant || 'Unknown plant'
          : groupBy === 'plant_size'
            ? `${line.plant} ${line.size}`.trim()
            : groupBy === 'vendor'
              ? line.vendor || 'No vendor'
              : docKey(d) || 'all';
      for (const b of [totals, bucket(key)]) {
        b.documents.add(docId);
        b.qty += qty;
        b.revenue += revenue;
        if (hasCost) {
          b.cost += cost;
          b.costKnownRevenue += revenue;
        }
      }
    }
    if (docMatched && d.customer) countedCustomers.add(d.customer);
    if (docMatched && !lineFilter) {
      const key = docKey(d);
      totals.total += sign * (Number(d.total) || 0);
      if (key) bucket(key).total += sign * (Number(d.total) || 0);
      totals.documents.add(docId);
      if (key) bucket(key).documents.add(docId);
    }
  }

  const rows = sortRows([...buckets.values()].map(bucketRow), String(args.sortBy || ''));
  const limit = limitOf(args);
  return {
    filtersApplied: { ...args, documentTypes: args.documentTypes || ['invoice', 'credit_memo'] },
    notes: [
      'merchandiseRevenue = qty × unit price on lines (no tax/freight/discount). documentTotal = invoice grand totals (incl. tax, freight, discount) and is only filled when no plant/size/vendor filter is used.',
      'Credit memos are subtracted. Cost/profit only cover lines with a saved cost.'
    ],
    matchedCustomers: args.customer ? [...countedCustomers].slice(0, 15) : undefined,
    matchedPlants: lineFilter ? [...matchedPlants].slice(0, 20) : undefined,
    totals: bucketRow({ ...totals, key: 'total' }),
    rowCount: rows.length,
    rows: groupBy === 'none' ? [] : rows.slice(0, limit),
    rowsTruncated: rows.length > limit
  };
}

function listDocuments(ledger: ReportLedger, args: Record<string, any>) {
  const lineFilter = Boolean(args.plant || args.size || args.vendor);
  const docs = filterDocuments(ledger, {
    ...args,
    documentTypes:
      Array.isArray(args.documentTypes) && args.documentTypes.length > 0
        ? args.documentTypes
        : ['invoice', 'credit_memo', 'estimate']
  })
    .filter((d) => !lineFilter || (d.lines || []).some((l) => lineMatches(l, args)))
    .sort((a, b) => (args.sortBy === 'total' ? b.total - a.total : b.date.localeCompare(a.date)));
  const limit = limitOf(args);
  return {
    count: docs.length,
    totalOfListed: round2(
      docs.reduce((s, d) => s + (d.type === 'credit_memo' ? -1 : 1) * (Number(d.total) || 0), 0)
    ),
    documents: docs.slice(0, limit).map((d) => ({
      type: d.type,
      number: d.number,
      customer: d.customer,
      date: d.date,
      dueDate: d.dueDate || null,
      rep: d.rep || null,
      paymentStatus: d.type === 'invoice' ? d.paymentStatus || 'unpaid' : null,
      paidAt: d.paidAt || null,
      orderNumber: d.orderNumber || null,
      poNumber: d.poNumber || null,
      subtotal: d.subtotal,
      tax: d.tax,
      freight: d.freight,
      discount: d.discount,
      total: d.total,
      lines: args.includeLines
        ? (d.lines || []).filter((l) => !lineFilter || lineMatches(l, args))
        : undefined
    })),
    truncated: docs.length > limit
  };
}

function queryOrders(ledger: ReportLedger, args: Record<string, any>) {
  const lineFilter = Boolean(args.plant || args.size || args.vendor);
  const orders = (ledger.orders || []).filter(
    (o) =>
      inRange(o.date, args.dateFrom, args.dateTo) &&
      inRange(o.loadingDate || '', args.loadingFrom, args.loadingTo) &&
      textMatches(o.customer, args.customer) &&
      textMatches(o.rep || 'No sales rep', args.rep) &&
      textMatches(o.truck || 'No truck', args.truck) &&
      (!args.status || o.status === args.status) &&
      (args.directShip == null || Boolean(o.directShip) === Boolean(args.directShip)) &&
      (!args.onlyUnfinished || o.status !== 'completed') &&
      (!lineFilter || o.items.some((i) => lineMatches(i, args)))
  );
  const groupBy = String(args.groupBy || 'none');
  const rows = new Map<string, { key: string; orders: Set<string>; qty: number; loaded: number; pulled: number; value: number }>();
  const total = { orders: new Set<string>(), qty: 0, loaded: 0, pulled: 0, value: 0 };
  for (const o of orders) {
    for (const i of o.items) {
      if (lineFilter && !lineMatches(i, args)) continue;
      const key =
        groupBy === 'customer'
          ? o.customer
          : groupBy === 'plant'
            ? i.plant
            : groupBy === 'plant_size'
              ? `${i.plant} ${i.size}`.trim()
              : groupBy === 'status'
                ? o.status
                : groupBy === 'truck'
                  ? o.truck || 'No truck'
                  : groupBy === 'rep'
                    ? o.rep || 'No sales rep'
                    : groupBy === 'vendor'
                      ? i.vendor || 'No vendor'
                      : groupBy === 'month'
                        ? periodKey(o.date, 'month')
                        : groupBy === 'order'
                          ? `${o.orderNumber} · ${o.customer}`
                          : 'all';
      const row = rows.get(key) || { key, orders: new Set(), qty: 0, loaded: 0, pulled: 0, value: 0 };
      for (const r of [row, total]) {
        r.orders.add(o.orderNumber + o.customer);
        r.qty += i.qty || 0;
        r.loaded += i.loaded || 0;
        r.pulled += i.pulled || 0;
        r.value += (i.qty || 0) * (Number(i.price) || 0);
      }
      rows.set(key, row);
    }
  }
  const limit = limitOf(args);
  const shape = (r: { key: string; orders: Set<string>; qty: number; loaded: number; pulled: number; value: number }) => ({
    key: r.key,
    orderCount: r.orders.size,
    qty: r.qty,
    loadedQty: r.loaded,
    pulledQty: r.pulled,
    remainingToLoad: Math.max(0, r.qty - r.loaded),
    pricedValue: round2(r.value)
  });
  const sorted = [...rows.values()].map(shape).sort((a, b) => b.qty - a.qty);
  return {
    filtersApplied: args,
    matchedCustomers: args.customer ? distinctMatches(orders, (o) => o.customer) : undefined,
    totals: shape({ key: 'total', ...total }),
    rows: groupBy === 'none' ? [] : sorted.slice(0, limit),
    rowsTruncated: sorted.length > limit,
    orders: args.includeOrders
      ? orders
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, limit)
          .map((o) => ({
            ...o,
            items: o.items.filter((i) => !lineFilter || lineMatches(i, args))
          }))
      : undefined
  };
}

function queryInventory(ledger: ReportLedger, args: Record<string, any>) {
  const items = (ledger.inventory || []).filter(
    (p) =>
      textMatches(p.plant, args.plant) &&
      sizeMatches(p.size, args.size) &&
      textMatches(p.category || '', args.category) &&
      textMatches(p.location || '', args.location) &&
      (args.minQty == null || p.qty >= Number(args.minQty)) &&
      (args.maxQty == null || p.qty <= Number(args.maxQty)) &&
      (!args.readyBy || (p.readyDate && p.readyDate <= String(args.readyBy)))
  );
  const sortBy = String(args.sortBy || 'qty');
  items.sort((a, b) =>
    sortBy === 'name'
      ? a.plant.localeCompare(b.plant)
      : sortBy === 'ready'
        ? String(a.readyDate || '9999').localeCompare(String(b.readyDate || '9999'))
        : sortBy === 'qty_asc'
          ? a.qty - b.qty
          : b.qty - a.qty
  );
  const limit = limitOf(args);
  return {
    count: items.length,
    totalQty: items.reduce((s, p) => s + (p.qty || 0), 0),
    totalListValue: round2(items.reduce((s, p) => s + (p.qty || 0) * (Number(p.listPrice) || 0), 0)),
    items: items.slice(0, limit),
    truncated: items.length > limit
  };
}

function queryVendorBills(ledger: ReportLedger, args: Record<string, any>) {
  const bills = (ledger.vendorBills || []).filter(
    (b) =>
      inRange(b.date, args.dateFrom, args.dateTo) &&
      inRange(b.paidAt || '', args.paidFrom, args.paidTo) &&
      textMatches(b.vendor, args.vendor) &&
      (!args.status || b.status === args.status) &&
      (!args.item || b.lines.some((l) => textMatches(l.item, args.item))) &&
      (!args.category || b.lines.some((l) => textMatches(l.category || '', args.category)))
  );
  const groupBy = String(args.groupBy || 'none');
  const rows = new Map<string, { key: string; bills: number; total: number }>();
  for (const b of bills) {
    const key =
      groupBy === 'vendor'
        ? b.vendor
        : groupBy === 'month'
          ? periodKey(b.date, 'month')
          : groupBy === 'status'
            ? b.status
            : groupBy === 'bill'
              ? `${b.billNumber} · ${b.vendor} · ${b.date}`
              : 'all';
    const row = rows.get(key) || { key, bills: 0, total: 0 };
    row.bills += 1;
    row.total += Number(b.total) || 0;
    rows.set(key, row);
  }
  const limit = limitOf(args);
  const sorted = [...rows.values()]
    .map((r) => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => b.total - a.total);
  return {
    available: Array.isArray(ledger.vendorBills),
    matchedVendors: args.vendor ? distinctMatches(bills, (b) => b.vendor) : undefined,
    billCount: bills.length,
    total: round2(bills.reduce((s, b) => s + (Number(b.total) || 0), 0)),
    rows: groupBy === 'none' ? [] : sorted.slice(0, limit),
    bills: args.includeBills
      ? bills.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit)
      : undefined
  };
}

function queryTrucks(ledger: ReportLedger, args: Record<string, any>) {
  const trucks = (ledger.trucks || []).filter(
    (t) =>
      inRange(t.loadingDate || '', args.loadingFrom, args.loadingTo) &&
      (!args.status || t.status === args.status) &&
      textMatches(t.name, args.name)
  );
  const limit = limitOf(args);
  return { count: trucks.length, trucks: trucks.slice(0, limit), truncated: trucks.length > limit };
}

const STR = { type: Type.STRING };
const DATE = (description: string) => ({ type: Type.STRING, description });
const LIMIT = { type: Type.INTEGER, description: `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` };

export const REPORT_TOOL_DECLARATIONS = [
  {
    name: 'query_sales',
    description:
      'Exact sales / quantity / cost / profit totals from saved invoices (minus credit memos), optionally filtered and grouped. Use for any sales, revenue, units sold, best sellers, profit, or customer/plant/rep/date breakdown question.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dateFrom: DATE('Inclusive start date YYYY-MM-DD (invoice date).'),
        dateTo: DATE('Inclusive end date YYYY-MM-DD.'),
        customer: { type: Type.STRING, description: 'Customer name words, e.g. "siteone baton rouge".' },
        rep: { type: Type.STRING, description: 'Sales rep name words.' },
        plant: { type: Type.STRING, description: 'Plant name words, e.g. "adagio" or "limelight".' },
        size: { type: Type.STRING, description: 'Container size like "#3", "3g", "tray", "B&B".' },
        vendor: { type: Type.STRING, description: 'Line vendor words.' },
        paymentStatus: { type: Type.STRING, enum: ['paid', 'pending', 'unpaid'] },
        documentTypes: {
          type: Type.ARRAY,
          items: { type: Type.STRING, enum: ['invoice', 'credit_memo', 'estimate'] },
          description: 'Defaults to invoices + credit memos. Use ["estimate"] only for quote questions.'
        },
        groupBy: {
          type: Type.STRING,
          enum: ['none', 'customer', 'plant', 'plant_size', 'rep', 'vendor', 'day', 'week', 'month', 'year', 'payment_status', 'document']
        },
        sortBy: { type: Type.STRING, enum: ['revenue', 'total', 'qty', 'profit', 'count', 'key'] },
        limit: LIMIT
      }
    }
  },
  {
    name: 'list_documents',
    description:
      'List individual invoices, credit memos, or estimates (number, customer, date, totals, payment status, optionally line items). Use to show specific documents, unpaid/overdue invoices, or details.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        documentTypes: {
          type: Type.ARRAY,
          items: { type: Type.STRING, enum: ['invoice', 'credit_memo', 'estimate'] }
        },
        dateFrom: DATE('Inclusive start date YYYY-MM-DD.'),
        dateTo: DATE('Inclusive end date YYYY-MM-DD.'),
        customer: STR,
        rep: STR,
        plant: STR,
        size: STR,
        vendor: STR,
        documentNumber: STR,
        paymentStatus: { type: Type.STRING, enum: ['paid', 'pending', 'unpaid'] },
        includeLines: { type: Type.BOOLEAN },
        sortBy: { type: Type.STRING, enum: ['date', 'total'] },
        limit: LIMIT
      }
    }
  },
  {
    name: 'query_orders',
    description:
      'Plant orders (what customers ordered, loading/pulling progress, trucks, direct ships). Filter and group; includeOrders returns order details with items and notes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dateFrom: DATE('Order created on/after YYYY-MM-DD.'),
        dateTo: DATE('Order created on/before YYYY-MM-DD.'),
        loadingFrom: DATE('Truck loading date on/after YYYY-MM-DD.'),
        loadingTo: DATE('Truck loading date on/before YYYY-MM-DD.'),
        customer: STR,
        rep: STR,
        truck: STR,
        plant: STR,
        size: STR,
        vendor: STR,
        status: { type: Type.STRING, enum: ['pending', 'loading', 'completed'] },
        directShip: { type: Type.BOOLEAN },
        onlyUnfinished: { type: Type.BOOLEAN },
        groupBy: {
          type: Type.STRING,
          enum: ['none', 'customer', 'plant', 'plant_size', 'status', 'truck', 'rep', 'vendor', 'month', 'order']
        },
        includeOrders: { type: Type.BOOLEAN },
        limit: LIMIT
      }
    }
  },
  {
    name: 'query_inventory',
    description: 'Live inventory on hand (quantity, list price, category, location, ready date).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        plant: STR,
        size: STR,
        category: STR,
        location: STR,
        minQty: { type: Type.NUMBER },
        maxQty: { type: Type.NUMBER },
        readyBy: DATE('Ready on/before YYYY-MM-DD.'),
        sortBy: { type: Type.STRING, enum: ['qty', 'qty_asc', 'name', 'ready'] },
        limit: LIMIT
      }
    }
  },
  {
    name: 'query_vendor_bills',
    description:
      'Vendor bills / purchasing spend (what we owe or paid vendors). Filter by vendor, status, bill date, paid date, line item or category.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        vendor: STR,
        status: STR,
        dateFrom: DATE('Bill date on/after YYYY-MM-DD.'),
        dateTo: DATE('Bill date on/before YYYY-MM-DD.'),
        paidFrom: DATE('Paid on/after YYYY-MM-DD.'),
        paidTo: DATE('Paid on/before YYYY-MM-DD.'),
        item: STR,
        category: STR,
        groupBy: { type: Type.STRING, enum: ['none', 'vendor', 'month', 'status', 'bill'] },
        includeBills: { type: Type.BOOLEAN },
        limit: LIMIT
      }
    }
  },
  {
    name: 'query_trucks',
    description: 'Trucks / loads with status, loading date, carrier, and order numbers.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: STR,
        status: { type: Type.STRING, enum: ['pending', 'loading', 'completed'] },
        loadingFrom: DATE('Loading date on/after YYYY-MM-DD.'),
        loadingTo: DATE('Loading date on/before YYYY-MM-DD.'),
        limit: LIMIT
      }
    }
  }
];

export interface ReportConversationInput {
  nursery: string;
  question: string;
  history: unknown;
  overview: unknown;
  ledger: ReportLedger;
  today?: unknown;
  timeZone?: unknown;
}

export const REPORT_MAX_TOOL_STEPS = 8;

function buildSystemInstruction(input: ReportConversationInput): string {
  const todayKey =
    typeof input.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.today)
      ? input.today
      : new Date().toISOString().slice(0, 10);
  const weekday = new Date(`${todayKey}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  const zone = typeof input.timeZone === 'string' && input.timeZone ? ` (${input.timeZone})` : '';

  return `You are the reports assistant inside NurseryOS for "${input.nursery}", a wholesale plant nursery. You answer questions from the owner and staff about their own sales, orders, trucks, inventory, and vendor bills.

Today is ${weekday}, ${todayKey}${zone}. Resolve relative dates yourself: "this week" = Sunday through today, "last week" = the previous Sunday–Saturday, "this month"/"last month"/"this year"/"Q3" = calendar periods, "yesterday", "September" = the most recent September, etc.

How to work:
1. Figure out exactly what is being asked: which measure (dollars, units, invoice count, profit, what's owed), for which customer / plant / size / rep / vendor, and which time period. In a follow-up, carry over the filters from earlier turns unless the user changes them.
2. Get numbers by calling the tools. The tools do exact filtering and math over every saved record — never add up or estimate figures yourself, and never reuse a number from an earlier answer without re-querying. The OVERVIEW below is only for quick headline totals.
3. Make as many tool calls as you need (e.g. one per period when comparing periods). If a customer/plant filter returns nothing, retry with fewer or different words (e.g. "adagio" instead of "miscanthus adagio", "siteone" instead of the full branch name) before saying there is no data.
4. When matchedCustomers / matchedPlants shows the filter caught several different names, say which ones were included.

Definitions:
- Sales = saved invoices minus credit memos. Estimates are quotes, not sales — only use them when asked about estimates/quotes.
- "Sales"/"revenue" in dollars means invoice totals (documentTotal) unless the question is about specific plants, in which case use merchandiseRevenue (qty × price). Say which one you used when it matters.
- Profit uses saved line costs; mention when cost is missing on many lines.

How to answer:
- Lead with the direct answer in the first line (the number, name, or list asked for). Then add only the supporting detail that helps — a short breakdown, the period and filters used, and anything notable.
- Match the length to the question: a one-line question gets a short answer; "give me a report on…" gets sections.
- Plain text only — this is shown in a plain text box. No markdown (no **, #, tables with pipes, or code fences). Use "-" bullets and one item per line, e.g. "- SiteOne Baton Rouge: $12,450.00 (8 invoices)".
- Format money as $1,234.56 and dates like "Sep 14, 2026".
- If the question is truly ambiguous in a way that changes the answer, answer the most likely reading and say in one line what you assumed (or ask one short clarifying question if you can't proceed).
- If the data doesn't contain what's needed (e.g. vendor bills not available for this user), say so plainly.

OVERVIEW (headline totals, computed over all saved records):
${JSON.stringify(input.overview)}`;
}

function historyContents(history: unknown): any[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (turn: any) =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim()
    )
    .slice(-12)
    .map((turn: { role: string; content: string }) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content.trim() }]
    }));
}

/** Runs one report turn: the model calls query tools over the ledger until it can answer. */
export async function runReportConversation(
  ai: { models: { generateContent: (req: any) => Promise<any> } },
  model: string,
  input: ReportConversationInput,
  withTimeout: <T>(promise: Promise<T>, label: string) => Promise<T>,
  onToolCall?: (name: string, args: unknown) => void
): Promise<string> {
  const systemInstruction = buildSystemInstruction(input);
  const contents: any[] = [
    ...historyContents(input.history),
    { role: 'user', parts: [{ text: input.question.trim() }] }
  ];
  for (let step = 0; step < REPORT_MAX_TOOL_STEPS; step += 1) {
    const finalStep = step === REPORT_MAX_TOOL_STEPS - 1;
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2,
          tools: [{ functionDeclarations: REPORT_TOOL_DECLARATIONS }],
          ...(finalStep ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {})
        }
      }),
      `Report (${model})`
    );
    const calls: any[] = response.functionCalls || [];
    if (calls.length === 0) {
      const text = String(response.text || '').trim();
      if (!text) throw new Error('Gemini returned an empty report.');
      return text;
    }
    contents.push(
      response.candidates?.[0]?.content || {
        role: 'model',
        parts: calls.map((c) => ({ functionCall: c }))
      }
    );
    contents.push({
      role: 'user',
      parts: calls.map((call) => {
        let result: unknown;
        try {
          result = runReportTool(input.ledger, call.name, call.args);
        } catch (toolErr: any) {
          result = { error: String(toolErr?.message || toolErr) };
        }
        onToolCall?.(call.name, call.args);
        return { functionResponse: { id: call.id, name: call.name, response: { result } } };
      })
    });
  }
  throw new Error('Report did not finish.');
}

export function runReportTool(ledger: ReportLedger, name: string, rawArgs: unknown): unknown {
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, any>) : {};
  switch (name) {
    case 'query_sales':
      return querySales(ledger, args);
    case 'list_documents':
      return listDocuments(ledger, args);
    case 'query_orders':
      return queryOrders(ledger, args);
    case 'query_inventory':
      return queryInventory(ledger, args);
    case 'query_vendor_bills':
      return queryVendorBills(ledger, args);
    case 'query_trucks':
      return queryTrucks(ledger, args);
    default:
      return { error: `Unknown tool ${name}` };
  }
}
