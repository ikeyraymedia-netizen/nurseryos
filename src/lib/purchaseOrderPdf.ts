import jsPDF from 'jspdf';
import { PurchaseOrder } from '../types';

function money(n: number): string {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function safeFileName(poNumber: string): string {
  return (poNumber || 'purchase-order').replace(/[^\w.-]+/g, '_');
}

export async function buildPurchaseOrderPdf(params: {
  nurseryName: string;
  order: PurchaseOrder;
  message?: string;
}): Promise<{ blob: Blob; fileName: string }> {
  const { default: autoTable } = await import('jspdf-autotable');
  const { nurseryName, order, message } = params;

  const pdf = new jsPDF('p', 'pt', 'letter');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.setTextColor(15, 118, 110);
  pdf.text('PURCHASE ORDER', margin, y);
  pdf.setFontSize(14);
  pdf.setTextColor(15, 23, 42);
  pdf.text(order.poNumber, pageWidth - margin, y, { align: 'right' });
  y += 22;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(51, 65, 85);
  pdf.text(`From: ${nurseryName || 'Nursery'}`, margin, y);
  y += 14;
  pdf.text(`Vendor: ${order.vendorName}`, margin, y);
  y += 14;
  pdf.text(`Order date: ${order.orderDate}`, margin, y);
  if (order.expectedDate) {
    y += 14;
    pdf.text(`Needed by: ${order.expectedDate}`, margin, y);
  }
  y += 18;

  if (message?.trim()) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(71, 85, 105);
    const msgLines = pdf.splitTextToSize(message.trim(), pageWidth - margin * 2);
    pdf.text(msgLines, margin, y);
    y += msgLines.length * 12 + 8;
  }

  autoTable(pdf, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Item', 'Size', 'Qty', 'Unit price', 'Line total']],
    body: order.items.map((line) => [
      line.plantName + (line.notes ? `\n${line.notes}` : ''),
      line.containerSize || '—',
      String(line.quantityOrdered),
      money(line.unitCost),
      money(line.quantityOrdered * line.unitCost)
    ]),
    styles: {
      fontSize: 9,
      cellPadding: 6,
      textColor: [15, 23, 42],
      lineColor: [226, 232, 240],
      lineWidth: 0.5
    },
    headStyles: {
      fillColor: [248, 250, 252],
      textColor: [51, 65, 85],
      fontStyle: 'bold'
    },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' }
    }
  });

  const tableEnd =
    ((pdf as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 14;
  let totalsY = tableEnd;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(51, 65, 85);
  pdf.text(`Subtotal: ${money(order.subtotal)}`, pageWidth - margin, totalsY, { align: 'right' });
  totalsY += 14;
  if (order.freightCharge) {
    pdf.text(`Freight: ${money(order.freightCharge)}`, pageWidth - margin, totalsY, { align: 'right' });
    totalsY += 14;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(15, 23, 42);
  pdf.text(`Total: ${money(order.grandTotal)}`, pageWidth - margin, totalsY, { align: 'right' });
  totalsY += 18;

  if (order.notes?.trim()) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(71, 85, 105);
    pdf.text('Notes:', margin, totalsY);
    totalsY += 12;
    pdf.setFont('helvetica', 'normal');
    const noteLines = pdf.splitTextToSize(order.notes.trim(), pageWidth - margin * 2);
    pdf.text(noteLines, margin, totalsY);
    totalsY += noteLines.length * 11 + 8;
  }

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text('Please confirm availability and ship date. Thank you.', margin, totalsY + 4);

  const blob = pdf.output('blob');
  return {
    blob,
    fileName: `${safeFileName(order.poNumber)}.pdf`
  };
}
