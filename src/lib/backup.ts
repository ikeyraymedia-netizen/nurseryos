import { Customer, CustomerOrder, CustomerDocument, Truck } from '../types';

function csvEscape(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))
  ];
  return lines.join('\n');
}

function downloadTextFile(filename: string, contents: string, mime = 'text/plain') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportNurseryBackup(params: {
  nurseryName: string;
  customers: Customer[];
  orders: CustomerOrder[];
  trucks: Truck[];
  documents: CustomerDocument[];
}) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = params.nurseryName.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'nursery';

  const customersCsv = toCsv(
    params.customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.contactEmail || '',
      phone: c.phone || '',
      paymentTerms: c.paymentTerms || '',
      billingAddress: c.billingAddress || '',
      shippingAddress: c.shippingAddress || c.receiverAddress || '',
      pointOfContact: c.pointOfContact || '',
      notes: c.notes || ''
    }))
  );

  const ordersCsv = toCsv(
    params.orders.map((o) => ({
      id: o.id,
      customerName: o.customerName,
      customerId: o.customerId || '',
      orderNumber: o.orderNumber,
      status: o.status,
      dateCreated: o.dateCreated,
      totalWeightLbs: o.totalWeightLbs,
      itemCount: o.items.length,
      totalQty: o.items.reduce((s, i) => s + i.quantity, 0),
      loadedQty: o.items.reduce((s, i) => s + i.loadedQuantity, 0)
    }))
  );

  const documentsCsv = toCsv(
    params.documents.map((d) => ({
      id: d.id,
      type: d.type,
      documentNumber: d.documentNumber,
      customerName: d.customerName,
      customerId: d.customerId,
      documentDate: d.documentDate,
      grandTotal: d.grandTotal,
      orderId: d.orderId || '',
      orderNumber: d.orderNumber || ''
    }))
  );

  const trucksCsv = toCsv(
    params.trucks.map((t) => ({
      id: t.id,
      name: t.name,
      carrier: t.carrier || '',
      truckType: t.truckType || '',
      status: t.status,
      loadingDate: t.loadingDate || '',
      orderCount: t.orderIds.length
    }))
  );

  const pack = {
    exportedAt: new Date().toISOString(),
    nurseryName: params.nurseryName,
    counts: {
      customers: params.customers.length,
      orders: params.orders.length,
      trucks: params.trucks.length,
      documents: params.documents.length
    },
    customers: params.customers,
    orders: params.orders,
    trucks: params.trucks,
    documents: params.documents,
    csv: {
      customers: customersCsv,
      orders: ordersCsv,
      trucks: trucksCsv,
      documents: documentsCsv
    }
  };

  downloadTextFile(
    `${safeName}-backup-${stamp}.json`,
    JSON.stringify(pack, null, 2),
    'application/json'
  );
  downloadTextFile(`${safeName}-customers-${stamp}.csv`, customersCsv, 'text/csv');
  downloadTextFile(`${safeName}-orders-${stamp}.csv`, ordersCsv, 'text/csv');
  downloadTextFile(`${safeName}-documents-${stamp}.csv`, documentsCsv, 'text/csv');
}
