import { Customer, CustomerDocument } from '../types';

export type StatementLineKind = 'invoice' | 'credit_memo';

export interface StatementLine {
  id: string;
  kind: StatementLineKind;
  documentNumber: string;
  documentDate: string;
  dueDate?: string;
  poNumber?: string;
  referencedInvoiceNumber?: string;
  amount: number;
  pastDue: boolean;
}

export interface CustomerStatementModel {
  asOf: string;
  customerName: string;
  billToName: string;
  billToAddress: string;
  paymentTerms?: string;
  lines: StatementLine[];
  invoicesOpen: number;
  creditsTotal: number;
  totalDue: number;
  totalPastDue: number;
}

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

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function parseDocDate(raw?: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(raw?: string): string {
  const d = parseDocDate(raw);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function isInvoicePastDue(doc: CustomerDocument, now = new Date()): boolean {
  if (doc.type !== 'invoice' || doc.paymentStatus === 'paid') return false;
  const today = startOfDay(now);
  const dueRaw = doc.dueDate || doc.documentDate || doc.createdAt;
  const due = parseDocDate(dueRaw);
  if (!due) return false;
  return startOfDay(due).getTime() < today.getTime();
}

/** Open invoices + credit memos for a customer account statement. */
export function buildCustomerStatementModel(params: {
  customer: Customer;
  documents: CustomerDocument[];
  asOf?: Date;
}): CustomerStatementModel {
  const asOf = params.asOf || new Date();
  const lines: StatementLine[] = [];
  let invoicesOpen = 0;
  let creditsTotal = 0;
  let pastDue = 0;

  for (const doc of params.documents) {
    if (doc.type === 'credit_memo') {
      const amount = Math.abs(doc.grandTotal || 0);
      creditsTotal += amount;
      lines.push({
        id: doc.id,
        kind: 'credit_memo',
        documentNumber: doc.documentNumber,
        documentDate: doc.documentDate || doc.createdAt,
        poNumber: doc.poNumber,
        referencedInvoiceNumber: doc.referencedInvoiceNumber,
        amount,
        pastDue: false
      });
      continue;
    }
    if (doc.type !== 'invoice') continue;
    if (doc.paymentStatus === 'paid') continue;
    const amount = doc.grandTotal || 0;
    invoicesOpen += amount;
    const overdue = isInvoicePastDue(doc, asOf);
    if (overdue) pastDue += amount;
    lines.push({
      id: doc.id,
      kind: 'invoice',
      documentNumber: doc.documentNumber,
      documentDate: doc.documentDate || doc.createdAt,
      dueDate: doc.dueDate,
      poNumber: doc.poNumber,
      amount,
      pastDue: overdue
    });
  }

  lines.sort((a, b) => String(a.documentDate).localeCompare(String(b.documentDate)));

  return {
    asOf: asOf.toISOString().slice(0, 10),
    customerName: params.customer.name,
    billToName: params.customer.billingName?.trim() || params.customer.name,
    billToAddress: (params.customer.billingAddress || '').trim(),
    paymentTerms: params.customer.paymentTerms,
    lines,
    invoicesOpen,
    creditsTotal,
    totalDue: Math.max(0, invoicesOpen - creditsTotal),
    totalPastDue: Math.max(0, pastDue)
  };
}

export function defaultCustomerStatementSubject(
  nurseryName: string,
  customerName: string,
  asOf: string
): string {
  return `Account Statement — ${customerName} — ${asOf} from ${nurseryName || 'Nursery'}`;
}

export function buildCustomerStatementEmailText(params: {
  nurseryName: string;
  statement: CustomerStatementModel;
  message?: string;
}): string {
  const { nurseryName, statement, message } = params;
  const lineRows = statement.lines.map((line) => {
    const kind = line.kind === 'credit_memo' ? 'Credit' : 'Invoice';
    const due = line.dueDate ? ` due ${formatShortDate(line.dueDate)}` : '';
    const po = line.poNumber ? ` PO ${line.poNumber}` : '';
    const ref = line.referencedInvoiceNumber ? ` ref ${line.referencedInvoiceNumber}` : '';
    const status =
      line.kind === 'credit_memo' ? 'Credit' : line.pastDue ? 'Past due' : 'Open';
    const signed =
      line.kind === 'credit_memo' ? `-${money(line.amount)}` : money(line.amount);
    return `${formatShortDate(line.documentDate)}  ${line.documentNumber}  ${kind}${po}${ref}${due}  ${signed}  (${status})`;
  });

  return [
    `${(nurseryName || 'Nursery').toUpperCase()}`,
    'Account Statement',
    `As of: ${formatShortDate(statement.asOf)}`,
    '',
    `Bill to: ${statement.billToName}`,
    statement.billToAddress || '',
    statement.paymentTerms ? `Terms: ${statement.paymentTerms}` : '',
    '',
    message?.trim() ? `${message.trim()}\n` : '',
    'Open activity:',
    '----------------------------------------',
    ...(lineRows.length > 0 ? lineRows : ['(No open invoices or credits)']),
    '----------------------------------------',
    `Invoices open: ${money(statement.invoicesOpen)}`,
    `Credits: -${money(statement.creditsTotal)}`,
    `Amount due: ${money(statement.totalDue)}`,
    `Past due: ${money(statement.totalPastDue)}`,
    '',
    'Please remit payment for any past-due balance. Thank you for your business.',
    nurseryName || 'Nursery'
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function buildCustomerStatementEmailHtml(params: {
  nurseryName: string;
  statement: CustomerStatementModel;
  message?: string;
}): string {
  const { nurseryName, statement, message } = params;
  const rows =
    statement.lines.length === 0
      ? `<tr><td colspan="6" style="padding:12px 10px;color:#64748b;text-align:center;">No open invoices or credits</td></tr>`
      : statement.lines
          .map((line) => {
            const kindLabel = line.kind === 'credit_memo' ? 'Credit memo' : 'Invoice';
            const status =
              line.kind === 'credit_memo'
                ? 'Credit'
                : line.pastDue
                  ? 'Past due'
                  : 'Open';
            const statusColor =
              line.kind === 'credit_memo'
                ? '#9f1239'
                : line.pastDue
                  ? '#b91c1c'
                  : '#0f766e';
            const amountDisplay =
              line.kind === 'credit_memo'
                ? `-${money(line.amount)}`
                : money(line.amount);
            const detail = [
              line.poNumber ? `PO ${escapeHtml(line.poNumber)}` : '',
              line.referencedInvoiceNumber
                ? `Ref ${escapeHtml(line.referencedInvoiceNumber)}`
                : ''
            ]
              .filter(Boolean)
              .join(' · ');
            return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${escapeHtml(
          formatShortDate(line.documentDate)
        )}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">
          <div style="font-weight:700;">${escapeHtml(line.documentNumber)}</div>
          ${
            detail
              ? `<div style="color:#64748b;font-size:12px;margin-top:2px;">${detail}</div>`
              : ''
          }
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(kindLabel)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${escapeHtml(
          formatShortDate(line.dueDate)
        )}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:${
          line.kind === 'credit_memo' ? '#9f1239' : '#0f172a'
        };">${amountDisplay}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:${statusColor};">${escapeHtml(
          status
        )}</td>
      </tr>`;
          })
          .join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:680px;margin:24px auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;background:#0f172a;color:#fff;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;">Account Statement</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px;">${escapeHtml(
        nurseryName || 'Nursery'
      )}</div>
      <div style="font-size:14px;margin-top:6px;opacity:0.95;">As of ${escapeHtml(
        formatShortDate(statement.asOf)
      )}</div>
    </div>
    <div style="padding:20px 24px;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;">Bill to</p>
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;">${escapeHtml(statement.billToName)}</p>
      ${
        statement.billToAddress
          ? `<p style="margin:0 0 8px;font-size:13px;color:#475569;white-space:pre-wrap;">${escapeHtml(
              statement.billToAddress
            )}</p>`
          : ''
      }
      ${
        statement.paymentTerms
          ? `<p style="margin:0 0 12px;font-size:13px;"><strong>Terms:</strong> ${escapeHtml(
              statement.paymentTerms
            )}</p>`
          : ''
      }
      ${
        message?.trim()
          ? `<p style="margin:12px 0 16px;padding:12px;background:#f1f5f9;border-radius:8px;font-size:14px;line-height:1.5;">${escapeHtml(
              message.trim()
            )}</p>`
          : ''
      }
      <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;">
        <thead>
          <tr style="background:#f8fafc;text-align:left;">
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Date</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Document</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Type</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;">Due</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:right;">Amount</th>
            <th style="padding:8px 10px;border-bottom:2px solid #cbd5e1;text-align:right;">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:18px;margin-left:auto;max-width:280px;font-size:14px;">
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:#475569;">
          <span>Invoices open</span><strong style="color:#0f172a;">${money(statement.invoicesOpen)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:#9f1239;">
          <span>Credits</span><strong>-${money(statement.creditsTotal)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;padding:10px 0 4px;border-top:2px solid #0f172a;margin-top:6px;font-size:16px;font-weight:800;color:#0f172a;">
          <span>Amount due</span><span>${money(statement.totalDue)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:${
          statement.totalPastDue > 0 ? '#b91c1c' : '#64748b'
        };">
          <span>Past due</span><strong>${money(statement.totalPastDue)}</strong>
        </div>
      </div>
      <p style="margin:24px 0 0;font-size:12px;color:#64748b;line-height:1.5;">
        Please remit payment for any past-due balance. Reply to this email with questions. Thank you for your business.
      </p>
    </div>
  </div>
</body>
</html>`;
}
