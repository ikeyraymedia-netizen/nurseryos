import { CustomerOrder, CustomerDocument, PlantOrderItem } from '../types';

/** Default upload-estimate footer. Drop it once the estimate becomes an invoice or order. */
const UNCONVERTED_ESTIMATE_NOTE_PATTERNS = [
  /Estimate from uploaded paperwork\.\s*/gi,
  /Not yet converted to a plant order\.?\s*/gi,
  /Presupuesto de documento subido\.\s*/gi,
  /Aún no convertido a pedido de plantas\.?\s*/gi
];

export function notesWithoutUnconvertedEstimate(notes: string | undefined | null): string {
  if (!notes) return '';
  let next = notes;
  for (const pattern of UNCONVERTED_ESTIMATE_NOTE_PATTERNS) {
    next = next.replace(pattern, '');
  }
  return next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** True when the order has pricing entered (line prices and/or invoice details). */
export function orderHasPricing(order: CustomerOrder): boolean {
  const pricedLines = order.items.some((item) => typeof item.unitPrice === 'number' && item.unitPrice > 0);
  const hasDetails = Boolean(
    order.invoiceDetails &&
      (order.invoiceDetails.invoiceNumber ||
        order.invoiceDetails.invoiceDate ||
        (order.invoiceDetails.taxRate != null && order.invoiceDetails.taxRate > 0) ||
        (order.invoiceDetails.taxAmount != null && order.invoiceDetails.taxAmount > 0) ||
        (order.invoiceDetails.freightCharge != null && order.invoiceDetails.freightCharge > 0) ||
        (order.invoiceDetails.discount != null && order.invoiceDetails.discount > 0) ||
        order.invoiceDetails.notes)
  );
  return pricedLines || hasDetails;
}

export function itemInvoicedQty(item: PlantOrderItem): number {
  return Math.min(item.quantity, Math.max(0, item.invoicedQuantity ?? 0));
}

export function itemRemainingInvoiceQty(item: PlantOrderItem): number {
  return Math.max(0, item.quantity - itemInvoicedQty(item));
}

export function orderFullyInvoiced(order: CustomerOrder): boolean {
  if (order.items.length === 0) return false;
  return order.items.every((item) => itemRemainingInvoiceQty(item) <= 0);
}

/** Lines with `quantity` set to remaining uninvoiced qty (excludes fully invoiced lines). */
export function orderItemsRemainingForInvoice(order: CustomerOrder): PlantOrderItem[] {
  return order.items
    .map((item) => ({
      ...item,
      quantity: itemRemainingInvoiceQty(item)
    }))
    .filter((item) => item.quantity > 0);
}

export function invoicesForOrder(
  orderId: string,
  documents: Array<Pick<CustomerDocument, 'type' | 'orderId' | 'id' | 'documentNumber' | 'grandTotal'>>
): CustomerDocument[] {
  return documents.filter(
    (d) => d.type === 'invoice' && d.orderId === orderId
  ) as CustomerDocument[];
}

export function orderHasSavedInvoice(
  orderId: string,
  documents: Array<Pick<CustomerDocument, 'type' | 'orderId'>>
): boolean {
  return documents.some((d) => d.type === 'invoice' && d.orderId === orderId);
}

/** Priced order that does not yet have a saved invoice on the customer record. */
export function orderNeedsInvoiceSave(
  order: CustomerOrder,
  documents: Array<Pick<CustomerDocument, 'type' | 'orderId'>>
): boolean {
  return orderHasPricing(order) && !orderHasSavedInvoice(order.id, documents);
}

export function buildOrdersNeedingInvoiceSet(
  orders: CustomerOrder[],
  documents: Array<Pick<CustomerDocument, 'type' | 'orderId'>>
): Set<string> {
  const ids = new Set<string>();
  for (const order of orders) {
    if (orderNeedsInvoiceSave(order, documents)) ids.add(order.id);
  }
  return ids;
}

export function bumpInvoicedQuantities(
  orderItems: PlantOrderItem[],
  invoicedLines: Array<{ id: string; quantity: number }>
): PlantOrderItem[] {
  const byId = new Map(invoicedLines.map((line) => [line.id, line.quantity]));
  return orderItems.map((item) => {
    const add = byId.get(item.id) ?? 0;
    if (add <= 0) return item;
    const next = Math.min(item.quantity, itemInvoicedQty(item) + add);
    return {
      ...item,
      invoicedQuantity: next > 0 ? next : undefined
    };
  });
}

function lineText(value?: string | null): string {
  return String(value || '').trim();
}

/** Plant, size, quantity, notes, and which lines exist — not load progress or vendor. */
export function orderInvoiceContentChanged(
  before: PlantOrderItem[] | undefined,
  after: PlantOrderItem[]
): boolean {
  const signature = (items: PlantOrderItem[]) =>
    items
      .map((item) =>
        [
          item.id,
          lineText(item.plantName).toLowerCase(),
          lineText(item.containerSize).toLowerCase(),
          Number(item.quantity) || 0,
          lineText(item.notes)
        ].join('\u001f')
      )
      .join('\u001e');
  return signature(before || []) !== signature(after);
}

function invoiceLineFromOrder(
  orderLine: PlantOrderItem,
  existing?: CustomerDocument['items'][number]
): CustomerDocument['items'][number] {
  const unitPrice =
    typeof existing?.unitPrice === 'number'
      ? existing.unitPrice
      : typeof orderLine.unitPrice === 'number'
        ? orderLine.unitPrice
        : 0;
  return {
    id: orderLine.id,
    plantName: lineText(orderLine.plantName),
    containerSize: lineText(orderLine.containerSize),
    quantity: Math.max(0, Number(orderLine.quantity) || 0),
    unitPrice,
    unitCost: existing?.unitCost ?? orderLine.unitCost,
    notes: lineText(orderLine.notes) || undefined,
    substitutes: existing?.substitutes
  };
}

function invoiceTotals(
  doc: Pick<CustomerDocument, 'discount' | 'taxAmount' | 'taxRate' | 'freightCharge'>,
  items: CustomerDocument['items']
): { subtotal: number; salesTax: number; grandTotal: number } {
  const subtotal = Number(
    items.reduce((sum, item) => sum + item.quantity * (Number(item.unitPrice) || 0), 0).toFixed(2)
  );
  const discount = Math.min(subtotal, Math.max(0, Number(doc.discount) || 0));
  const taxable = Math.max(0, subtotal - discount);
  const salesTax =
    doc.taxAmount != null
      ? Number(doc.taxAmount) || 0
      : Number(((taxable * (Number(doc.taxRate) || 0)) / 100).toFixed(2));
  const freight = Number(doc.freightCharge) || 0;
  const grandTotal = Number((subtotal - discount + salesTax + freight).toFixed(2));
  return { subtotal, salesTax, grandTotal };
}

function sameInvoiceItems(
  before: CustomerDocument['items'],
  after: CustomerDocument['items']
): boolean {
  if (before.length !== after.length) return false;
  return before.every((item, index) => {
    const next = after[index];
    return (
      item.id === next.id &&
      lineText(item.plantName) === lineText(next.plantName) &&
      lineText(item.containerSize) === lineText(next.containerSize) &&
      Number(item.quantity) === Number(next.quantity) &&
      lineText(item.notes) === lineText(next.notes) &&
      Number(item.unitPrice) === Number(next.unitPrice)
    );
  });
}

export interface InvoiceProjectionUpdate {
  id: string;
  items: CustomerDocument['items'];
  subtotal: number;
  salesTax: number;
  grandTotal: number;
}

export interface OrderInvoiceProjection {
  updates: InvoiceProjectionUpdate[];
  /** Quantity of each order line now sitting on the linked invoices. */
  invoicedById: Map<string, number>;
}

function invoicesNewestFirst(invoices: CustomerDocument[]): CustomerDocument[] {
  return [...invoices].sort((a, b) =>
    String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
  );
}

/**
 * Make linked invoices follow the order's plants.
 * One invoice is rewritten to match the order and keeps each line's price.
 * Split invoices keep their split, then quantities are adjusted so the
 * invoices together match the order.
 */
export function projectOrderOntoInvoices(
  orderItems: PlantOrderItem[],
  invoices: CustomerDocument[]
): OrderInvoiceProjection {
  const linked = invoices.filter((doc) => doc.type === 'invoice');
  const invoicedById = new Map<string, number>();
  if (linked.length === 0) return { updates: [], invoicedById };

  const orderLines = orderItems.filter((item) => lineText(item.plantName));
  let nextById = new Map<string, CustomerDocument['items']>();

  if (linked.length === 1) {
    const invoice = linked[0];
    const existing = new Map(invoice.items.map((item) => [item.id, item]));
    nextById.set(
      invoice.id,
      orderLines.map((line) => invoiceLineFromOrder(line, existing.get(line.id)))
    );
  } else {
    const newest = invoicesNewestFirst(linked);
    nextById = new Map(linked.map((invoice) => [invoice.id, invoice.items.map((item) => ({ ...item }))]));
    const orderById = new Map(orderLines.map((line) => [line.id, line]));

    for (const [invoiceId, items] of nextById) {
      nextById.set(
        invoiceId,
        items
          .filter((item) => orderById.has(item.id))
          .map((item) => {
            const orderLine = orderById.get(item.id)!;
            return {
              ...invoiceLineFromOrder(orderLine, item),
              quantity: item.quantity
            };
          })
      );
    }

    for (const orderLine of orderLines) {
      const holders = newest.filter((invoice) =>
        (nextById.get(invoice.id) || []).some((item) => item.id === orderLine.id)
      );
      const desired = Math.max(0, Number(orderLine.quantity) || 0);
      if (holders.length === 0) {
        const target = newest[0];
        const items = nextById.get(target.id) || [];
        items.push(invoiceLineFromOrder(orderLine));
        nextById.set(target.id, items);
        continue;
      }
      let sum = holders.reduce(
        (total, invoice) =>
          total +
          (nextById.get(invoice.id) || [])
            .filter((item) => item.id === orderLine.id)
            .reduce((lineTotal, item) => lineTotal + (Number(item.quantity) || 0), 0),
        0
      );
      if (sum === desired) continue;
      if (sum < desired) {
        const target = holders[0];
        const items = (nextById.get(target.id) || []).map((item) =>
          item.id === orderLine.id ? { ...item, quantity: item.quantity + (desired - sum) } : item
        );
        nextById.set(target.id, items);
        continue;
      }
      let extra = sum - desired;
      for (const invoice of holders) {
        if (extra <= 0) break;
        const items = (nextById.get(invoice.id) || []).flatMap((item) => {
          if (item.id !== orderLine.id || extra <= 0) return [item];
          const remove = Math.min(extra, Number(item.quantity) || 0);
          extra -= remove;
          const quantity = (Number(item.quantity) || 0) - remove;
          return quantity > 0 ? [{ ...item, quantity }] : [];
        });
        nextById.set(invoice.id, items);
      }
    }
  }

  const updates: InvoiceProjectionUpdate[] = [];
  for (const invoice of linked) {
    const items = nextById.get(invoice.id) || [];
    for (const item of items) {
      invoicedById.set(item.id, (invoicedById.get(item.id) || 0) + (Number(item.quantity) || 0));
    }
    if (
      sameInvoiceItems(invoice.items, items) &&
      invoice.subtotal === invoiceTotals(invoice, items).subtotal &&
      invoice.grandTotal === invoiceTotals(invoice, items).grandTotal
    ) {
      continue;
    }
    const totals = invoiceTotals(invoice, items);
    updates.push({ id: invoice.id, items, ...totals });
  }

  return { updates, invoicedById };
}

/** Point each order line's invoiced quantity at what the linked invoices now bill. */
export function withInvoicedQuantitiesFromInvoices(
  items: PlantOrderItem[],
  invoicedById: Map<string, number>
): PlantOrderItem[] | null {
  let changed = false;
  const next = items.map((item) => {
    const sum = invoicedById.get(item.id) ?? 0;
    const qty = sum > 0 ? Math.min(Number(item.quantity) || 0, sum) : undefined;
    const prev = item.invoicedQuantity && item.invoicedQuantity > 0 ? item.invoicedQuantity : undefined;
    if (prev === qty) return item;
    changed = true;
    return { ...item, invoicedQuantity: qty };
  });
  return changed ? next : null;
}

export function restoreInvoicedQuantitiesAfterDelete(
  orderItems: PlantOrderItem[],
  documentLines: Array<{ id: string; quantity: number }>
): PlantOrderItem[] {
  const byId = new Map(documentLines.map((line) => [line.id, line.quantity]));
  return orderItems.map((item) => {
    const subtract = byId.get(item.id) ?? 0;
    if (subtract <= 0) return item;
    const next = Math.max(0, itemInvoicedQty(item) - subtract);
    return {
      ...item,
      invoicedQuantity: next > 0 ? next : undefined
    };
  });
}
