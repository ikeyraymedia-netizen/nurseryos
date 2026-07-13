import { CustomerOrder, CustomerDocument } from '../types';

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

export function orderHasSavedInvoice(
  orderId: string,
  documents: Array<Pick<CustomerDocument, 'type' | 'orderId'>>
): boolean {
  return documents.some((d) => d.type === 'invoice' && d.orderId === orderId);
}

/** Priced order that still needs Create Invoice → Save to Customer. */
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
