import jsPDF from 'jspdf';
import { CustomerStatementModel } from './customerStatementEmail';

function money(n: number): string {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatShortDate(raw?: string): string {
  if (!raw) return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function safeFileName(name: string): string {
  return (name || 'statement').replace(/[^\w.-]+/g, '_');
}

export async function buildCustomerStatementPdf(params: {
  nurseryName: string;
  statement: CustomerStatementModel;
  message?: string;
}): Promise<{ blob: Blob; fileName: string }> {
  const { default: autoTable } = await import('jspdf-autotable');
  const { nurseryName, statement, message } = params;
  const pdf = new jsPDF('p', 'pt', 'letter');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(100, 116, 139);
  pdf.text('ACCOUNT STATEMENT', margin, y);
  y += 18;
  pdf.setFontSize(16);
  pdf.setTextColor(15, 23, 42);
  pdf.text(nurseryName || 'Nursery', margin, y);
  y += 16;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text(`As of ${formatShortDate(statement.asOf)}`, margin, y);
  y += 20;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text('BILL TO', margin, y);
  y += 13;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(15, 23, 42);
  pdf.text(statement.billToName || statement.customerName, margin, y);
  y += 14;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  if (statement.billToAddress) {
    const address = pdf.splitTextToSize(statement.billToAddress, pageWidth - margin * 2);
    pdf.text(address, margin, y);
    y += address.length * 12 + 4;
  }
  if (statement.paymentTerms) {
    pdf.text(`Terms: ${statement.paymentTerms}`, margin, y);
    y += 14;
  }
  if (message?.trim()) {
    y += 4;
    const note = pdf.splitTextToSize(message.trim(), pageWidth - margin * 2);
    pdf.text(note, margin, y);
    y += note.length * 12 + 8;
  }

  const body =
    statement.lines.length === 0
      ? [['', 'No open invoices or credits', '', '', '', '']]
      : statement.lines.map((line) => {
          const detail = [
            line.poNumber ? `PO ${line.poNumber}` : '',
            line.referencedInvoiceNumber ? `Ref ${line.referencedInvoiceNumber}` : ''
          ]
            .filter(Boolean)
            .join(' · ');
          return [
            formatShortDate(line.documentDate),
            detail ? `${line.documentNumber}\n${detail}` : line.documentNumber,
            line.kind === 'credit_memo' ? 'Credit memo' : 'Invoice',
            formatShortDate(line.dueDate),
            line.kind === 'credit_memo' ? `-${money(line.amount)}` : money(line.amount),
            line.kind === 'credit_memo' ? 'Credit' : line.pastDue ? 'Past due' : 'Open'
          ];
        });

  autoTable(pdf, {
    startY: y + 6,
    margin: { left: margin, right: margin },
    head: [['Date', 'Document', 'Type', 'Due', 'Amount', 'Status']],
    body,
    styles: {
      fontSize: 8,
      cellPadding: 4,
      textColor: [15, 23, 42],
      lineColor: [226, 232, 240],
      lineWidth: 0.4,
      overflow: 'linebreak'
    },
    headStyles: {
      fillColor: [248, 250, 252],
      textColor: [51, 65, 85],
      fontStyle: 'bold'
    },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right' }
    }
  });

  let totalsY =
    ((pdf as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 18;
  const pageHeight = pdf.internal.pageSize.getHeight();
  if (totalsY > pageHeight - 90) {
    pdf.addPage();
    totalsY = margin;
  }

  const right = pageWidth - margin;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Invoices open', margin, totalsY);
  pdf.text(money(statement.invoicesOpen), right, totalsY, { align: 'right' });
  totalsY += 14;
  pdf.setTextColor(159, 18, 57);
  pdf.text('Credits', margin, totalsY);
  pdf.text(
    statement.creditsTotal > 0.009 ? `-${money(statement.creditsTotal)}` : money(0),
    right,
    totalsY,
    { align: 'right' }
  );
  totalsY += 16;
  pdf.setDrawColor(15, 23, 42);
  pdf.setLineWidth(1);
  pdf.line(margin, totalsY - 8, right, totalsY - 8);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(15, 23, 42);
  pdf.text('Amount due', margin, totalsY);
  pdf.text(money(statement.totalDue), right, totalsY, { align: 'right' });
  totalsY += 16;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  if (statement.totalPastDue > 0) pdf.setTextColor(185, 28, 28);
  else pdf.setTextColor(100, 116, 139);
  pdf.text('Past due', margin, totalsY);
  pdf.text(money(statement.totalPastDue), right, totalsY, { align: 'right' });
  totalsY += 22;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  const footer = pdf.splitTextToSize(
    'Please remit payment for any past-due balance. Thank you for your business.',
    pageWidth - margin * 2
  );
  pdf.text(footer, margin, totalsY);

  return {
    blob: pdf.output('blob'),
    fileName: `${safeFileName(`statement-${statement.customerName}-${statement.asOf}`)}.pdf`
  };
}
