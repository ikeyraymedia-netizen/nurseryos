import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from 'firebase/storage';
import jsPDF from 'jspdf';
import { storage } from '../firebase';
import { InventoryPlant } from '../types';
import { updateInventoryPlant } from './inventory';
import { deliverPdfBlob, type PdfDelivery } from './downloadPdf';
import {
  imageSrcToDataUrl,
  resolveNurseryLogoSrc,
  type JsPdfImageFormat
} from './nurseryBranding';
import { groupPlantsByAvailabilityCategory } from './availabilityGrouping';

/** Compress an image file to a JPEG blob suitable for Storage upload. */
export async function fileToCompressedJpegBlob(
  file: File,
  maxEdge = 1280,
  quality = 0.82
): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPG, or WebP).');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image.'));
      el.src = objectUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process image.');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not compress image.'))),
        'image/jpeg',
        quality
      );
    });
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function photoObjectPath(tenantId: string, plantId: string): string {
  return `tenants/${tenantId}/inventory/${plantId}/photo.jpg`;
}

export async function uploadInventoryPlantPhoto(params: {
  tenantId: string;
  plant: InventoryPlant;
  file: File;
}): Promise<InventoryPlant> {
  const path = photoObjectPath(params.tenantId, params.plant.id);
  const blob = await fileToCompressedJpegBlob(params.file);
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public,max-age=31536000'
  });
  const photoUrl = await getDownloadURL(storageRef);
  const updated: InventoryPlant = {
    ...params.plant,
    photoUrl,
    photoPath: path,
    dateUpdated: new Date().toISOString()
  };
  await updateInventoryPlant(updated);
  return updated;
}

export async function removeInventoryPlantPhoto(plant: InventoryPlant): Promise<InventoryPlant> {
  if (plant.photoPath) {
    try {
      await deleteObject(ref(storage, plant.photoPath));
    } catch (err) {
      console.warn('Could not delete plant photo from storage:', err);
    }
  }
  const updated: InventoryPlant = {
    ...plant,
    photoUrl: null,
    photoPath: null,
    dateUpdated: new Date().toISOString()
  };
  await updateInventoryPlant(updated);
  return updated;
}

function isHttpUrl(value?: string | null): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

/** Format readyDate (YYYY-MM-DD) for availability lists. */
function formatReadyDate(readyDate: string | null | undefined): string {
  const raw = (readyDate || '').trim();
  if (!raw) return '—';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  return raw.slice(0, 10);
}

function safeFileStem(name: string): string {
  return (name || 'availability').replace(/[^\w.\-]+/g, '_').slice(0, 60);
}

function filterExportPlants(plants: InventoryPlant[], inStockOnly?: boolean): InventoryPlant[] {
  return inStockOnly === false
    ? plants
    : plants.filter((p) => (p.quantityAvailable || 0) > 0);
}

async function resolveExportLogo(
  nurseryName: string,
  nurseryLogoSrc?: string | null
): Promise<{ dataUrl: string; format: JsPdfImageFormat } | null> {
  const src = nurseryLogoSrc || resolveNurseryLogoSrc(nurseryName);
  if (!src) return null;
  try {
    return await imageSrcToDataUrl(src);
  } catch (err) {
    console.warn('Availability export logo could not be loaded:', err);
    return null;
  }
}

async function logoBytesForExcel(
  logo: { dataUrl: string; format: JsPdfImageFormat } | null
): Promise<{ buffer: ArrayBuffer; extension: 'png' | 'jpeg' } | null> {
  if (!logo) return null;
  const comma = logo.dataUrl.indexOf(',');
  if (comma < 0) return null;
  const b64 = logo.dataUrl.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    buffer: bytes.buffer,
    extension: logo.format === 'PNG' ? 'png' : 'jpeg'
  };
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

type AvailabilityCol = 'plant' | 'size' | 'qty' | 'price' | 'ready' | 'photo';

function availabilityColumns(includeQuantity: boolean, includePhotos: boolean): AvailabilityCol[] {
  const cols: AvailabilityCol[] = ['plant', 'size'];
  if (includeQuantity) cols.push('qty');
  cols.push('price', 'ready');
  if (includePhotos) cols.push('photo');
  return cols;
}

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function colLetter(index1Based: number): string {
  return COL_LETTERS[index1Based - 1] || 'A';
}

function availabilityHeaderLabel(col: AvailabilityCol): string {
  switch (col) {
    case 'plant':
      return 'Plant';
    case 'size':
      return 'Size';
    case 'qty':
      return 'Qty';
    case 'price':
      return 'Price';
    case 'ready':
      return 'Ready Date';
    case 'photo':
      return 'Photo';
  }
}

function availabilityPdfHeader(col: AvailabilityCol): string {
  switch (col) {
    case 'plant':
      return 'PLANT';
    case 'size':
      return 'SIZE';
    case 'qty':
      return 'QTY';
    case 'price':
      return 'PRICE';
    case 'ready':
      return 'READY DATE';
    case 'photo':
      return 'PHOTO';
  }
}

function plantCellValue(plant: InventoryPlant, col: AvailabilityCol): string | number {
  switch (col) {
    case 'plant':
      return plant.plantName || '';
    case 'size':
      return plant.containerSize || '';
    case 'qty':
      return plant.quantityAvailable ?? 0;
    case 'price':
      return plant.listPrice != null ? plant.listPrice : '';
    case 'ready':
      return plant.readyDate?.trim() ? formatReadyDate(plant.readyDate) : '';
    case 'photo':
      return '';
  }
}

function plantPdfCellValue(plant: InventoryPlant, col: AvailabilityCol): string {
  switch (col) {
    case 'plant':
      return plant.plantName || '—';
    case 'size':
      return String(plant.containerSize || '—');
    case 'qty':
      return String(plant.quantityAvailable ?? 0);
    case 'price':
      return money(plant.listPrice);
    case 'ready':
      return formatReadyDate(plant.readyDate);
    case 'photo':
      return isHttpUrl(plant.photoUrl) ? 'View photo' : '—';
  }
}

function exportMetaLine(includeQuantity: boolean, includePhotos: boolean): string {
  const bits = [`Generated ${todayLabel()}`];
  if (!includeQuantity) bits.push('no quantities');
  if (!includePhotos) bits.push('no photo links');
  if (includePhotos) bits.push('Click “View photo” to open plant photos');
  return bits.join(' · ');
}

/** Build & download a polished Excel availability list (logo, no raw photo URL column). */
export async function exportAvailabilityExcel(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  inStockOnly?: boolean;
  /** When false, omit the Qty column (catalog-style availability). Default true. */
  includeQuantity?: boolean;
  /** When false, omit the Photo column. Default true. */
  includePhotos?: boolean;
  nurseryLogoSrc?: string | null;
}): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const includeQuantity = params.includeQuantity !== false;
  const includePhotos = params.includePhotos !== false;
  const cols = availabilityColumns(includeQuantity, includePhotos);
  const colCount = cols.length;
  const lastColLetter = colLetter(colCount);
  const groups = groupPlantsByAvailabilityCategory(
    filterExportPlants(params.plants, includeQuantity ? params.inStockOnly : false)
  );
  const logo = await resolveExportLogo(params.nurseryName, params.nurseryLogoSrc);
  const logoBytes = await logoBytesForExcel(logo);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NurseryOS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Availability');

  const widthByCol: Record<AvailabilityCol, number> = {
    plant: includeQuantity ? 36 : 40,
    size: 12,
    qty: 10,
    price: 12,
    ready: 14,
    photo: 14
  };
  sheet.columns = cols.map((key) => ({ key, width: widthByCol[key] }));

  if (logoBytes) {
    sheet.getColumn(1).width = 12;
    if (colCount >= 2) sheet.getColumn(2).width = 28;
    sheet.mergeCells(`B1:${lastColLetter}1`);
    sheet.mergeCells(`B2:${lastColLetter}2`);
    sheet.mergeCells(`B3:${lastColLetter}3`);
  } else {
    sheet.mergeCells(`A1:${lastColLetter}1`);
    sheet.mergeCells(`A2:${lastColLetter}2`);
    sheet.mergeCells(`A3:${lastColLetter}3`);
  }

  sheet.getRow(1).height = logoBytes ? 28 : 22;
  sheet.getRow(2).height = logoBytes ? 20 : 18;
  sheet.getRow(3).height = 16;
  if (logoBytes) sheet.getRow(4).height = 18;

  const titleCell = sheet.getCell(logoBytes ? 'B1' : 'A1');
  titleCell.value = (params.nurseryName || 'Nursery').toUpperCase();
  titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF0F172A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

  const subtitleCell = sheet.getCell(logoBytes ? 'B2' : 'A2');
  subtitleCell.value = 'Current Availability';
  subtitleCell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF0E7490' } };
  subtitleCell.alignment = { vertical: 'middle' };

  const metaCell = sheet.getCell(logoBytes ? 'B3' : 'A3');
  metaCell.value = exportMetaLine(includeQuantity, includePhotos);
  metaCell.font = { name: 'Calibri', size: 9, color: { argb: 'FF64748B' } };
  metaCell.alignment = { vertical: 'middle' };

  if (logoBytes) {
    const imageId = workbook.addImage({
      buffer: logoBytes.buffer,
      extension: logoBytes.extension
    });
    sheet.addImage(imageId, {
      tl: { col: 0, row: 0 },
      ext: { width: 72, height: 72 }
    });
    sheet.getColumn(1).width = widthByCol.plant;
  }

  const headerRowNum = logoBytes ? 6 : 5;
  sheet.views = [{ state: 'frozen', ySplit: headerRowNum }];
  const headerRow = sheet.getRow(headerRowNum);
  headerRow.values = cols.map(availabilityHeaderLabel);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF334155' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF1F5F9' }
    };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } }
    };
    cell.alignment = { vertical: 'middle' };
  });

  const priceCol = cols.indexOf('price') + 1;
  const photoCol = cols.indexOf('photo') + 1;
  const qtyCol = cols.indexOf('qty') + 1;
  const rightAlignCols = new Set(
    [qtyCol, priceCol].filter((n) => n > 0)
  );

  let rowIdx = headerRowNum + 1;
  let alt = false;

  for (const group of groups) {
    const catRow = sheet.getRow(rowIdx);
    sheet.mergeCells(rowIdx, 1, rowIdx, colCount);
    catRow.getCell(1).value = group.category.toUpperCase();
    catRow.getCell(1).font = {
      name: 'Calibri',
      size: 10,
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };
    catRow.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0E7490' }
    };
    catRow.getCell(1).alignment = { vertical: 'middle', indent: 1 };
    catRow.height = 20;
    rowIdx += 1;
    alt = false;

    for (const plant of group.plants) {
      const row = sheet.getRow(rowIdx);
      row.values = cols.map((col) => plantCellValue(plant, col));
      row.height = 18;

      const bg = alt ? 'FFF8FAFC' : 'FFFFFFFF';
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF0F172A' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.alignment = rightAlignCols.has(c)
          ? { vertical: 'middle', horizontal: 'right' }
          : { vertical: 'middle' };
      }

      if (plant.listPrice != null && priceCol > 0) {
        row.getCell(priceCol).numFmt = '"$"#,##0.00';
      }

      if (includePhotos && photoCol > 0 && isHttpUrl(plant.photoUrl)) {
        const photoCell = row.getCell(photoCol);
        photoCell.value = {
          text: 'View photo',
          hyperlink: plant.photoUrl
        };
        photoCell.font = {
          name: 'Calibri',
          size: 10,
          bold: true,
          color: { argb: 'FF0E7490' },
          underline: true
        };
      }

      rowIdx += 1;
      alt = !alt;
    }

    rowIdx += 1;
  }

  if (groups.length === 0) {
    sheet.getCell(`A${rowIdx}`).value = 'No plants to list.';
    sheet.getCell(`A${rowIdx}`).font = {
      name: 'Calibri',
      size: 10,
      italic: true,
      color: { argb: 'FF64748B' }
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const fileName = `${safeFileStem(params.nurseryName)}_availability.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build a PDF availability list with nursery logo and clickable photo links. */
export async function exportAvailabilityPdf(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  inStockOnly?: boolean;
  /** When false, omit the Qty column (catalog-style availability). Default true. */
  includeQuantity?: boolean;
  /** When false, omit the Photo column. Default true. */
  includePhotos?: boolean;
  nurseryLogoSrc?: string | null;
}): Promise<PdfDelivery> {
  const { default: autoTable } = await import('jspdf-autotable');
  const includeQuantity = params.includeQuantity !== false;
  const includePhotos = params.includePhotos !== false;
  const cols = availabilityColumns(includeQuantity, includePhotos);
  const groups = groupPlantsByAvailabilityCategory(
    filterExportPlants(params.plants, includeQuantity ? params.inStockOnly : false)
  );
  const logo = await resolveExportLogo(params.nurseryName, params.nurseryLogoSrc);

  const pdf = new jsPDF('p', 'pt', 'letter');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 40;
  const headerTop = margin;
  let textX = margin;
  let cursor = margin;
  const usableWidth = pageWidth - margin * 2;
  const photoColIndex = cols.indexOf('photo');

  if (logo) {
    try {
      const logoSize = 52;
      pdf.addImage(logo.dataUrl, logo.format, margin, headerTop, logoSize, logoSize);
      textX = margin + logoSize + 12;
    } catch (logoErr) {
      console.warn('Availability PDF logo could not be embedded:', logoErr);
    }
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor(15, 23, 42);
  pdf.text((params.nurseryName || 'Nursery').toUpperCase(), textX, headerTop + 18);
  pdf.setFontSize(11);
  pdf.setTextColor(14, 116, 144);
  pdf.text('CURRENT AVAILABILITY', textX, headerTop + 34);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text(exportMetaLine(includeQuantity, includePhotos), textX, headerTop + 48);
  cursor = headerTop + (logo ? 68 : 60);

  pdf.setDrawColor(226, 232, 240);
  pdf.setLineWidth(0.8);
  pdf.line(margin, cursor, pageWidth - margin, cursor);
  cursor += 16;

  if (groups.length === 0) {
    pdf.setFontSize(10);
    pdf.setTextColor(100, 116, 139);
    pdf.text('No plants to list.', margin, cursor);
  }

  const preferredWidths: Partial<Record<AvailabilityCol, number>> = {
    plant: includeQuantity ? 170 : 210,
    size: 70,
    qty: 42,
    price: 55,
    ready: 82,
    photo: 90
  };
  const fixedSum = cols.reduce((sum, col) => {
    if (col === 'plant') return sum;
    return sum + (preferredWidths[col] || 60);
  }, 0);
  const plantWidth = Math.max(120, usableWidth - fixedSum);
  const columnStyles: Record<number, { cellWidth: number }> = {};
  cols.forEach((col, idx) => {
    columnStyles[idx] = {
      cellWidth: col === 'plant' ? plantWidth : preferredWidths[col] || 60
    };
  });

  const head = [cols.map(availabilityPdfHeader)];

  for (const group of groups) {
    if (cursor > pdf.internal.pageSize.getHeight() - 80) {
      pdf.addPage();
      cursor = margin;
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(14, 116, 144);
    pdf.text(group.category.toUpperCase(), margin, cursor);
    cursor += 10;

    const body = group.plants.map((plant) => cols.map((col) => plantPdfCellValue(plant, col)));

    autoTable(pdf, {
      startY: cursor,
      margin: { left: margin, right: margin },
      head,
      body,
      theme: 'plain',
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: { top: 8, right: 6, bottom: 8, left: 4 },
        valign: 'middle',
        overflow: 'linebreak',
        textColor: [15, 23, 42],
        lineWidth: 0,
        minCellHeight: 22
      },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [71, 85, 105],
        fontStyle: 'bold',
        fontSize: 8,
        cellPadding: { top: 8, right: 6, bottom: 8, left: 4 },
        lineWidth: { bottom: 0.8 },
        lineColor: [148, 163, 184]
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252]
      },
      columnStyles,
      didParseCell: (data) => {
        if (photoColIndex < 0) return;
        if (data.section === 'body' && data.column.index === photoColIndex) {
          const plant = group.plants[data.row.index];
          if (plant && isHttpUrl(plant.photoUrl)) {
            data.cell.styles.textColor = [14, 116, 144];
            data.cell.styles.fontStyle = 'bold';
          } else {
            data.cell.styles.textColor = [148, 163, 184];
            data.cell.styles.fontStyle = 'normal';
          }
        }
      },
      didDrawCell: (data) => {
        if (photoColIndex < 0) return;
        if (data.section !== 'body' || data.column.index !== photoColIndex) return;
        const plant = group.plants[data.row.index];
        if (!plant || !isHttpUrl(plant.photoUrl)) return;
        const { x, y: cy, width, height } = data.cell;
        pdf.link(x, cy, width, height, { url: plant.photoUrl });
      }
    });

    cursor =
      ((pdf as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursor) + 16;
  }

  const fileName = `${safeFileStem(params.nurseryName)}_availability.pdf`;
  return deliverPdfBlob(pdf.output('blob'), fileName);
}
