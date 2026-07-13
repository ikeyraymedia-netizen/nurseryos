import jsPDF from 'jspdf';
import { CustomerOrder, Truck } from '../types';

function normalizeLineKey(plantName: string, containerSize: string): string {
  return `${plantName.trim().toLowerCase()}::${containerSize.trim().toLowerCase()}`;
}

/** Draw a printable checkbox; optional X when already complete in the app. */
function drawCheckbox(
  pdf: jsPDF,
  x: number,
  yBaseline: number,
  checked: boolean,
  size = 10
): void {
  const top = yBaseline - size + 1;
  pdf.setDrawColor(60, 60, 60);
  pdf.setLineWidth(0.8);
  pdf.setFillColor(255, 255, 255);
  pdf.rect(x, top, size, size, 'FD');
  if (checked) {
    pdf.setDrawColor(6, 78, 59);
    pdf.setLineWidth(1.4);
    // Check mark
    pdf.line(x + 2, top + size / 2, x + size * 0.4, top + size - 2.5);
    pdf.line(x + size * 0.4, top + size - 2.5, x + size - 2, top + 2);
  }
}

export function downloadTruckPullSheetPdf(params: {
  truck: Truck;
  orders: CustomerOrder[];
  nurseryName?: string;
}): void {
  const { truck, orders, nurseryName = 'NurseryOS' } = params;
  const truckOrders = orders
    .filter((o) => truck.orderIds.includes(o.id) || o.truckId === truck.id)
    .sort((a, b) => {
      const idxA = truck.orderIds.indexOf(a.id);
      const idxB = truck.orderIds.indexOf(b.id);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

  const consolidated = new Map<
    string,
    { plantName: string; containerSize: string; quantity: number; pulled: number; loaded: number }
  >();

  for (const order of truckOrders) {
    for (const item of order.items) {
      const key = normalizeLineKey(item.plantName, item.containerSize);
      const existing = consolidated.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.pulled += item.pulledQuantity ?? 0;
        existing.loaded += item.loadedQuantity;
      } else {
        consolidated.set(key, {
          plantName: item.plantName,
          containerSize: item.containerSize,
          quantity: item.quantity,
          pulled: item.pulledQuantity ?? 0,
          loaded: item.loadedQuantity
        });
      }
    }
  }

  const lines = [...consolidated.values()].sort((a, b) =>
    a.plantName.localeCompare(b.plantName) || a.containerSize.localeCompare(b.containerSize)
  );

  const pdf = new jsPDF('p', 'pt', 'letter');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
  };

  const write = (text: string, opts?: { size?: number; bold?: boolean; color?: [number, number, number] }) => {
    ensureSpace((opts?.size || 10) + 6);
    pdf.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    pdf.setFontSize(opts?.size || 10);
    pdf.setTextColor(...(opts?.color || [30, 30, 30]));
    pdf.text(text, margin, y);
    y += (opts?.size || 10) + 6;
  };

  // Column layout (letter width ~612pt, content ~532)
  const col = {
    plant: margin,
    size: margin + 250,
    qty: margin + 320,
    pulled: margin + 370,
    loaded: margin + 460
  };

  write('PULL SHEET', { size: 16, bold: true, color: [6, 78, 59] });
  write(nurseryName, { size: 11, bold: true });
  write(truck.name, { size: 13, bold: true });

  const meta = [
    truck.loadingDate ? `Loading: ${truck.loadingDate}` : null,
    truck.owner ? `Owner: ${truck.owner}` : null,
    truck.truckType ? `Type: ${truck.truckType}` : null,
    truck.carrier ? `Carrier: ${truck.carrier}` : null,
    `Orders: ${truckOrders.length}`,
    `Printed: ${new Date().toLocaleString()}`
  ].filter(Boolean) as string[];

  meta.forEach((line) => write(line, { size: 9, color: [80, 80, 80] }));
  y += 4;
  write('Check Pulled / Loaded as you go (same as truck workspace)', {
    size: 9,
    color: [100, 100, 100]
  });
  y += 4;

  write('CONSOLIDATED PULL LIST', { size: 11, bold: true, color: [6, 78, 59] });
  y += 2;

  // Table header
  ensureSpace(20);
  pdf.setFillColor(236, 253, 245);
  pdf.rect(margin, y - 12, contentWidth, 18, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(6, 78, 59);
  pdf.text('PLANT', col.plant + 2, y);
  pdf.text('SIZE', col.size, y);
  pdf.text('QTY', col.qty, y);
  pdf.text('PULLED', col.pulled + 14, y);
  pdf.text('LOADED', col.loaded + 14, y);
  y += 16;

  pdf.setTextColor(30, 30, 30);
  let totalQty = 0;
  for (const line of lines) {
    const nameLines = pdf.splitTextToSize(line.plantName, 240);
    const rowH = Math.max(16, nameLines.length * 11 + 4);
    ensureSpace(rowH);
    totalQty += line.quantity;

    const baseline = y;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(30, 30, 30);
    pdf.text(nameLines[0], col.plant + 2, baseline);
    for (let i = 1; i < nameLines.length; i++) {
      pdf.text(nameLines[i], col.plant + 2, baseline + i * 11);
    }
    pdf.text(line.containerSize, col.size, baseline);
    pdf.setFont('helvetica', 'bold');
    pdf.text(String(line.quantity), col.qty, baseline);
    pdf.setFont('helvetica', 'normal');

    // Pulled checkbox + qty progress
    drawCheckbox(pdf, col.pulled, baseline, line.pulled >= line.quantity && line.quantity > 0);
    pdf.setFontSize(7);
    pdf.setTextColor(80, 80, 80);
    pdf.text(`${line.pulled}/${line.quantity}`, col.pulled + 14, baseline);

    // Loaded checkbox + qty progress
    drawCheckbox(pdf, col.loaded, baseline, line.loaded >= line.quantity && line.quantity > 0);
    pdf.text(`${line.loaded}/${line.quantity}`, col.loaded + 14, baseline);

    y += rowH;
  }

  y += 4;
  write(`Total plants to pull: ${totalQty}`, { size: 10, bold: true });
  y += 10;

  write('BY CUSTOMER / ORDER', { size: 11, bold: true, color: [6, 78, 59] });

  for (const order of truckOrders) {
    y += 6;
    write(`${order.customerName}  ·  Order #${order.orderNumber}`, { size: 10, bold: true });
    if (order.stagedLocation) {
      write(`Staged: ${order.stagedLocation}`, { size: 8, color: [90, 90, 90] });
    }

    // Mini header for this order
    ensureSpace(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(6, 78, 59);
    pdf.text('PULLED', margin + 8, y);
    pdf.text('LOADED', margin + 58, y);
    pdf.text('ITEM', margin + 108, y);
    y += 10;

    for (const item of order.items) {
      const pulled = item.pulledQuantity ?? 0;
      const label = `${item.quantity} × ${item.containerSize}  ${item.plantName}${
        item.isAddition ? '  (addition)' : ''
      }`;
      const nameLines = pdf.splitTextToSize(label, contentWidth - 120);
      const rowH = Math.max(16, nameLines.length * 11 + 2);
      ensureSpace(rowH);

      const baseline = y;
      drawCheckbox(pdf, margin + 12, baseline, pulled >= item.quantity && item.quantity > 0);
      drawCheckbox(
        pdf,
        margin + 62,
        baseline,
        item.loadedQuantity >= item.quantity && item.quantity > 0
      );

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(30, 30, 30);
      pdf.text(nameLines[0], margin + 108, baseline);
      for (let i = 1; i < nameLines.length; i++) {
        pdf.text(nameLines[i], margin + 108, baseline + i * 11);
      }
      if (item.notes) {
        pdf.setFontSize(7);
        pdf.setTextColor(146, 64, 14);
        pdf.text(`Note: ${item.notes}`, margin + 108, baseline + nameLines.length * 11);
        y += rowH + 8;
      } else {
        y += rowH;
      }
    }
  }

  const safeName = truck.name.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'truck';
  const datePart = truck.loadingDate || new Date().toISOString().slice(0, 10);
  pdf.save(`pull-sheet-${safeName}-${datePart}.pdf`);
}
