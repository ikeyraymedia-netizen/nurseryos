import { CustomerOrder, CustomerDocument, PlantOrderItem } from '../types';

/** True when the order has pricing entered (line prices and/or invoice details). */
export function orderHasPricing(order: CustomerOrder): boolean {
  const pricedLines = order.items.some((item) => typeof item.unitPrice === 'number' && item.unitPrice > 0);
  const hasDetails = Boolean(
    order.invoiceDetails &&
      (order.invoiceDetails.invoiceNumber ||
        order.invoiceDetails.invoiceDate ||
        (order.invoiceDetails.taxRate != null && order.invoiceDetails.taxRate > 0) ||
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
