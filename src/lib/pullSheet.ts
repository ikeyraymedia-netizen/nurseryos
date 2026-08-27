import jsPDF from 'jspdf';
import { CustomerOrder, Truck } from '../types';
import { truckCustomerOrders } from './loadSequence';
import { orderRefLabel } from './orderLabels';

const UNASSIGNED_VENDOR = 'Unassigned';

export function normalizeVendorName(vendor?: string | null): string {
  const v = String(vendor || '').trim();
  return v || UNASSIGNED_VENDOR;
}

function normalizeVendor(vendor?: string | null): string {
  return normalizeVendorName(vendor);
}

function normalizeLineKey(plantName: string, containerSize: string, vendor: string): string {
  return `${plantName.trim().toLowerCase()}::${containerSize.trim().toLowerCase()}::${vendor.toLowerCase()}`;
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
    pdf.line(x + 2, top + size / 2, x + size * 0.4, top + size - 2.5);
    pdf.line(x + size * 0.4, top + size - 2.5, x + size - 2, top + 2);
  }
}

type PullLine = {
  plantName: string;
  containerSize: string;
  vendor: string;
  quantity: number;
  pulled: number;
  loaded: number;
};

function compareVendors(a: string, b: string): number {
  if (a === UNASSIGNED_VENDOR && b !== UNASSIGNED_VENDOR) return 1;
  if (b === UNASSIGNED_VENDOR && a !== UNASSIGNED_VENDOR) return -1;
  return a.localeCompare(b);
}

function buildConsolidatedPullLines(truckOrders: CustomerOrder[]): PullLine[] {
  const consolidated = new Map<string, PullLine>();

  for (const order of truckOrders) {
    for (const item of order.items) {
      const vendor = normalizeVendor(item.vendor);
      const key = normalizeLineKey(item.plantName, item.containerSize, vendor);
      const existing = consolidated.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.pulled += item.pulledQuantity ?? 0;
        existing.loaded += item.loadedQuantity;
      } else {
        consolidated.set(key, {
          plantName: item.plantName,
          containerSize: item.containerSize,
          vendor,
          quantity: item.quantity,
          pulled: item.pulledQuantity ?? 0,
          loaded: item.loadedQuantity
        });
      }
    }
  }

  return [...consolidated.values()].sort(
    (a, b) =>
      compareVendors(a.vendor, b.vendor) ||
      a.plantName.localeCompare(b.plantName) ||
      a.containerSize.localeCompare(b.containerSize)
  );
}

function groupLinesByVendor(lines: PullLine[]): Array<[string, PullLine[]]> {
  const byVendor = new Map<string, PullLine[]>();
  for (const line of lines) {
    const list = byVendor.get(line.vendor) || [];
    list.push(line);
    byVendor.set(line.vendor, list);
  }
  return [...byVendor.entries()].sort(([a], [b]) => compareVendors(a, b));
}

export type VendorPullList = {
  vendor: string;
  quantity: number;
  /** Plain text ready to paste into a text / iMessage / WhatsApp. */
  text: string;
};

function collectOrdersForTrucks(orders: CustomerOrder[], trucks: Truck[]): CustomerOrder[] {
  const seen = new Set<string>();
  const result: CustomerOrder[] = [];
  for (const truck of trucks) {
    for (const order of truckCustomerOrders(orders, truck)) {
      if (seen.has(order.id)) continue;
      seen.add(order.id);
      result.push(order);
    }
  }
  return result;
}

/** Trucks scheduled to load on the same calendar day (`YYYY-MM-DD`). */
export function trucksLoadingOnDate(trucks: Truck[], loadingDate: string | undefined | null): Truck[] {
  const key = String(loadingDate || '').trim();
  if (!key) return [];
  return trucks.filter((t) => String(t.loadingDate || '').trim() === key);
}

function formatLoadingDateLabel(dateKey: string): string {
  try {
    return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch {
    return dateKey;
  }
}

/** Build per-vendor plain-text lists for one or more trucks (same day or a single truck). */
export function buildVendorPullListsForTrucks(params: {
  trucks: Truck[];
  orders: CustomerOrder[];
  nurseryName?: string;
  /** `day` = all trucks loading that date; `truck` = one truck only. */
  scope?: 'truck' | 'day';
}): VendorPullList[] {
  const { trucks, orders, nurseryName = 'NurseryOS', scope = 'truck' } = params;
  if (trucks.length === 0) return [];

  const truckByOrderId = new Map<string, Truck>();
  for (const truck of trucks) {
    for (const order of truckCustomerOrders(orders, truck)) {
      if (!truckByOrderId.has(order.id)) truckByOrderId.set(order.id, truck);
    }
  }

  const truckOrders = collectOrdersForTrucks(orders, trucks);
  const loadingKey = String(trucks[0]?.loadingDate || '').trim();
  const loadingLabel = loadingKey ? formatLoadingDateLabel(loadingKey) : null;
  const truckNames = trucks.map((t) => t.name).filter(Boolean);
  const showTruckOnOrder = scope === 'day' || trucks.length > 1;

  // vendor → order sections (preserve plant lines per order for staging)
  type OrderSection = {
    orderId: string;
    customerName: string;
    ref: string | null;
    stagedLocation: string;
    truckName: string;
    lines: Array<{ plantName: string; containerSize: string; quantity: number }>;
    quantity: number;
  };

  const byVendor = new Map<string, OrderSection[]>();

  for (const order of truckOrders) {
    const sectionsForOrder = new Map<string, OrderSection>();
    for (const item of order.items) {
      const vendor = normalizeVendor(item.vendor);
      let section = sectionsForOrder.get(vendor);
      if (!section) {
        section = {
          orderId: order.id,
          customerName: order.customerName,
          ref: orderRefLabel(order),
          stagedLocation: String(order.stagedLocation || '').trim(),
          truckName: truckByOrderId.get(order.id)?.name || '',
          lines: [],
          quantity: 0
        };
        sectionsForOrder.set(vendor, section);
      }
      section.lines.push({
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: item.quantity
      });
      section.quantity += item.quantity;
    }
    for (const [vendor, section] of sectionsForOrder) {
      const list = byVendor.get(vendor) || [];
      list.push(section);
      byVendor.set(vendor, list);
    }
  }

  const vendorNames = [...byVendor.keys()].sort(compareVendors);

  return vendorNames.map((vendor) => {
    const sections = (byVendor.get(vendor) || []).sort((a, b) => {
      const stageCmp = (a.stagedLocation || 'zzz').localeCompare(b.stagedLocation || 'zzz');
      if (stageCmp !== 0) return stageCmp;
      const truckCmp = a.truckName.localeCompare(b.truckName);
      if (truckCmp !== 0) return truckCmp;
      return a.customerName.localeCompare(b.customerName);
    });

    const quantity = sections.reduce((sum, s) => sum + s.quantity, 0);
    const header =
      vendor === UNASSIGNED_VENDOR
        ? 'Need from yard (no vendor assigned)'
        : `Need from ${vendor}`;

    const scopeLines: Array<string | null> =
      scope === 'day' || trucks.length > 1
        ? [
            `${nurseryName} · Loading ${loadingLabel || 'unscheduled'} · ${trucks.length} truck${
              trucks.length === 1 ? '' : 's'
            }`,
            truckNames.length > 0 ? `Trucks: ${truckNames.join(', ')}` : null
          ]
        : [
            `${nurseryName} · ${trucks[0].name}`,
            loadingLabel ? `Loading: ${loadingLabel}` : null
          ];

    const orderBlocks: string[] = [];
    for (const section of sections) {
      const titleParts = [section.customerName];
      if (section.ref) titleParts.push(section.ref);
      const meta: string[] = [];
      if (section.stagedLocation) meta.push(`Stage: ${section.stagedLocation}`);
      else meta.push('Stage: (not set)');
      if (showTruckOnOrder && section.truckName) meta.push(`Truck: ${section.truckName}`);

      orderBlocks.push(
        [
          `— ${titleParts.join(' · ')}`,
          `  ${meta.join(' · ')}`,
          ...section.lines
            .sort(
              (a, b) =>
                a.plantName.localeCompare(b.plantName) ||
                a.containerSize.localeCompare(b.containerSize)
            )
            .map((line) => `  • ${line.quantity} × ${line.containerSize}  ${line.plantName}`)
        ].join('\n')
      );
    }

    // Combined totals so the vendor still sees one shopping list
    const totals = new Map<string, { plantName: string; containerSize: string; quantity: number }>();
    for (const section of sections) {
      for (const line of section.lines) {
        const key = normalizeLineKey(line.plantName, line.containerSize, vendor);
        const existing = totals.get(key);
        if (existing) existing.quantity += line.quantity;
        else
          totals.set(key, {
            plantName: line.plantName,
            containerSize: line.containerSize,
            quantity: line.quantity
          });
      }
    }
    const totalLines = [...totals.values()].sort(
      (a, b) =>
        a.plantName.localeCompare(b.plantName) || a.containerSize.localeCompare(b.containerSize)
    );

    const text = [
      header,
      ...scopeLines,
      '',
      'BY ORDER / STAGE',
      ...orderBlocks,
      '',
      'COMBINED TOTALS',
      ...totalLines.map((line) => `• ${line.quantity} × ${line.containerSize}  ${line.plantName}`),
      '',
      `Total: ${quantity} plants`
    ]
      .filter((row) => row !== null)
      .join('\n');

    return { vendor, quantity, text };
  });
}

/** Build per-vendor plain-text lists for copying / texting growers (single truck). */
export function buildVendorPullLists(params: {
  truck: Truck;
  orders: CustomerOrder[];
  nurseryName?: string;
}): VendorPullList[] {
  return buildVendorPullListsForTrucks({
    trucks: [params.truck],
    orders: params.orders,
    nurseryName: params.nurseryName,
    scope: 'truck'
  });
}

/** Orders + item ids for a vendor across the given trucks. */
export function collectVendorOrderItems(params: {
  trucks: Truck[];
  orders: CustomerOrder[];
  vendor: string;
}): Array<{ order: CustomerOrder; itemIds: string[] }> {
  const vendorKey = normalizeVendorName(params.vendor);
  const truckOrders = collectOrdersForTrucks(params.orders, params.trucks);
  const result: Array<{ order: CustomerOrder; itemIds: string[] }> = [];
  for (const order of truckOrders) {
    const itemIds = order.items
      .filter((item) => normalizeVendorName(item.vendor) === vendorKey)
      .map((item) => item.id);
    if (itemIds.length > 0) result.push({ order, itemIds });
  }
  return result;
}

export function vendorItemsFullyPulled(params: {
  trucks: Truck[];
  orders: CustomerOrder[];
  vendor: string;
}): boolean {
  const groups = collectVendorOrderItems(params);
  if (groups.length === 0) return false;
  return groups.every(({ order, itemIds }) =>
    itemIds.every((id) => {
      const item = order.items.find((i) => i.id === id);
      return !!item && (item.pulledQuantity ?? 0) >= item.quantity;
    })
  );
}

export function downloadTruckPullSheetPdf(params: {
  truck: Truck;
  orders: CustomerOrder[];
  nurseryName?: string;
}): void {
  const { truck, orders, nurseryName = 'NurseryOS' } = params;
  const truckOrders = truckCustomerOrders(orders, truck);
  const lines = buildConsolidatedPullLines(truckOrders);
  const vendorGroups = groupLinesByVendor(lines);

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

  const write = (
    text: string,
    opts?: { size?: number; bold?: boolean; color?: [number, number, number] }
  ) => {
    ensureSpace((opts?.size || 10) + 6);
    pdf.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    pdf.setFontSize(opts?.size || 10);
    pdf.setTextColor(...(opts?.color || [30, 30, 30]));
    pdf.text(text, margin, y);
    y += (opts?.size || 10) + 6;
  };

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
    `Vendors: ${vendorGroups.length}`,
    `Printed: ${new Date().toLocaleString()}`
  ].filter(Boolean) as string[];

  meta.forEach((line) => write(line, { size: 9, color: [80, 80, 80] }));
  y += 4;
  write('Organized by vendor. Check Pulled / Loaded as you go (same as truck workspace)', {
    size: 9,
    color: [100, 100, 100]
  });
  y += 4;

  write('CONSOLIDATED PULL LIST (BY VENDOR)', { size: 11, bold: true, color: [6, 78, 59] });
  y += 2;

  const drawTableHeader = () => {
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
  };

  let totalQty = 0;
  for (const [vendor, vendorLines] of vendorGroups) {
    const vendorQty = vendorLines.reduce((sum, line) => sum + line.quantity, 0);
    ensureSpace(28);
    pdf.setFillColor(226, 232, 240);
    pdf.rect(margin, y - 11, contentWidth, 16, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(30, 41, 59);
    const vendorLabel =
      vendor === UNASSIGNED_VENDOR
        ? `NO VENDOR ASSIGNED  ·  ${vendorQty} plants`
        : `${vendor.toUpperCase()}  ·  ${vendorQty} plants`;
    pdf.text(vendorLabel, margin + 4, y);
    y += 18;

    drawTableHeader();

    for (const line of vendorLines) {
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

      drawCheckbox(pdf, col.pulled, baseline, line.pulled >= line.quantity && line.quantity > 0);
      pdf.setFontSize(7);
      pdf.setTextColor(80, 80, 80);
      pdf.text(`${line.pulled}/${line.quantity}`, col.pulled + 14, baseline);

      drawCheckbox(pdf, col.loaded, baseline, line.loaded >= line.quantity && line.quantity > 0);
      pdf.text(`${line.loaded}/${line.quantity}`, col.loaded + 14, baseline);

      y += rowH;
    }
    y += 8;
  }

  y += 2;
  write(`Total plants to pull: ${totalQty}`, { size: 10, bold: true });
  y += 10;

  write('BY CUSTOMER / ORDER', { size: 11, bold: true, color: [6, 78, 59] });

  for (const order of truckOrders) {
    y += 6;
    const ref = orderRefLabel(order);
    write(ref ? `${order.customerName}  ·  ${ref}` : order.customerName, {
      size: 10,
      bold: true
    });
    if (order.stagedLocation) {
      write(`Staged: ${order.stagedLocation}`, { size: 8, color: [90, 90, 90] });
    }

    ensureSpace(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(6, 78, 59);
    pdf.text('PULLED', margin + 8, y);
    pdf.text('LOADED', margin + 58, y);
    pdf.text('ITEM', margin + 108, y);
    y += 10;

    const orderItems = [...order.items].sort(
      (a, b) =>
        compareVendors(normalizeVendor(a.vendor), normalizeVendor(b.vendor)) ||
        a.plantName.localeCompare(b.plantName) ||
        a.containerSize.localeCompare(b.containerSize)
    );

    for (const item of orderItems) {
      const pulled = item.pulledQuantity ?? 0;
      const vendor = normalizeVendor(item.vendor);
      const vendorSuffix = vendor === UNASSIGNED_VENDOR ? '' : `  ·  ${vendor}`;
      const label = `${item.quantity} × ${item.containerSize}  ${item.plantName}${vendorSuffix}${
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
