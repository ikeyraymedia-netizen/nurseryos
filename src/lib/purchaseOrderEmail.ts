import { PurchaseOrder } from '../types';

function money(n: number) {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function defaultPurchaseOrderEmailSubject(
  nurseryName: string,
  order: PurchaseOrder
): string {
  return `Purchase Order ${order.poNumber} from ${nurseryName || 'Nursery'}`;
}

export function buildPurchaseOrderEmailText(params: {
  nurseryName: string;
  order: PurchaseOrder;
  message?: string;
}): string {
  const { nurseryName, order, message } = params;
  const lines = [
    `Purchase Order ${order.poNumber}`,
    `From: ${nurseryName}`,
    `Vendor: ${order.vendorName}`,
    `Order date: ${order.orderDate}`,
    order.expectedDate ? `Needed by: ${order.expectedDate}` : '',
    '',
    message?.trim() ? `${message.trim()}\n` : '',
    'Line items:',
    ...order.items.map(
      (line) =>
        `- ${line.plantName} ${line.containerSize || ''} × ${line.quantityOrdered} @ ${money(line.unitCost)}${
          line.notes ? ` (${line.notes})` : ''
        }`
    ),
    '',
    `Subtotal: ${money(order.subtotal)}`,
    order.freightCharge ? `Freight: ${money(order.freightCharge)}` : '',
    `Total: ${money(order.grandTotal)}`,
    order.notes ? `\nNotes: ${order.notes}` : '',
    '',
    'Please confirm availability and ship date. Thank you.'
  ].filter(Boolean);

  return lines.join('\n');
}

export function buildPurchaseOrderEmailHtml(params: {
  nurseryName: string;
  order: PurchaseOrder;
  message?: string;
}): string {
  const { nurseryName, order, message } = params;
  const rows = order.items
    .map(
      (line) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(line.plantName)}${
          line.notes
            ? `<div style="color:#64748b;font-size:12px;margin-top:2px;">${escapeHtml(line.notes)}</div>`
            : ''
        }</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(line.containerSize || '—')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${line.quantityOrdered}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${money(line.unitCost)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${money(
          line.quantityOrdered * line.unitCost
        )}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:24px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;background:#0f766e;color:#fff;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">Purchase Order</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px;">${escapeHtml(order.poNumber)}</div>
      <div style="font-size:14px;margin-top:6px;opacity:0.95;">From ${escapeHtml(nurseryName || 'Nursery')}</div>
    </div>
    <div style="padding:20px 24px;">
      <p style="margin:0 0 8px;font-size:14px;"><strong>Vendor:</strong> ${escapeHtml(order.vendorName)}</p>
      <p style="margin:0 0 8px;font-size:14px;"><strong>Order date:</strong> ${escapeHtml(order.orderDate)}</p>
      ${
        order.expectedDate
          ? `<p style="margin:0 0 8px;font-size:14px;"><strong>Needed by:</strong> ${escapeHtml(order.expectedDate)}</p>`
          : ''
      }
      ${
        message?.trim()
          ? `<p style="margin:16px 0;padding:12px;background:#f1f5f9;border-radius:8px;font-size:14px;line-height:1.5;">${escapeHtml(
              message.trim()
            )}</p>`
          : ''
      }
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;">
        <thead>
          <tr style="background:#f8fafc;text-align:left;">
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Item</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Size</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:right;">Qty</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:right;">Unit</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:16px;text-align:right;font-size:14px;">
        <div>Subtotal: <strong>${money(order.subtotal)}</strong></div>
        ${
          order.freightCharge
            ? `<div>Freight: <strong>${money(order.freightCharge)}</strong></div>`
            : ''
        }
        <div style="font-size:16px;margin-top:6px;">Total: <strong>${money(order.grandTotal)}</strong></div>
      </div>
      ${
        order.notes
          ? `<p style="margin:18px 0 0;font-size:13px;color:#475569;"><strong>Notes:</strong> ${escapeHtml(
              order.notes
            )}</p>`
          : ''
      }
      <p style="margin:20px 0 0;font-size:13px;color:#64748b;">Please confirm availability and ship date. Thank you.</p>
    </div>
  </div>
</body>
</html>`;
}
