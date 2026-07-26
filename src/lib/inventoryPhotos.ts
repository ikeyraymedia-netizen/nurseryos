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

function safeFileStem(name: string): string {
  return (name || 'availability').replace(/[^\w.\-]+/g, '_').slice(0, 60);
}

const UNCATEGORIZED = 'Uncategorized';

function categoryLabel(plant: InventoryPlant): string {
  const raw = (plant.category || '').trim();
  return raw || UNCATEGORIZED;
}

/** Sort by category, then plant name. */
function sortPlants(plants: InventoryPlant[]): InventoryPlant[] {
  return [...plants].sort((a, b) => {
    const cat = categoryLabel(a).localeCompare(categoryLabel(b), undefined, { sensitivity: 'base' });
    if (cat !== 0) return cat;
    return (a.plantName || '').localeCompare(b.plantName || '', undefined, { sensitivity: 'base' });
  });
}

/** Group sorted plants into category sections (preserves sort order). */
function groupPlantsByCategory(
  plants: InventoryPlant[]
): Array<{ category: string; plants: InventoryPlant[] }> {
  const groups: Array<{ category: string; plants: InventoryPlant[] }> = [];
  for (const plant of sortPlants(plants)) {
    const category = categoryLabel(plant);
    const last = groups[groups.length - 1];
    if (last && last.category === category) {
      last.plants.push(plant);
    } else {
      groups.push({ category, plants: [plant] });
    }
  }
  return groups;
}

function filterExportPlants(plants: InventoryPlant[], inStockOnly?: boolean): InventoryPlant[] {
  return inStockOnly === false
    ? plants
    : plants.filter((p) => (p.quantityAvailable || 0) > 0);
}

/** Build & download an Excel availability list with clickable photo links. */
export async function exportAvailabilityExcel(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  inStockOnly?: boolean;
}): Promise<void> {
  const XLSX = await import('xlsx');
  const groups = groupPlantsByCategory(filterExportPlants(params.plants, params.inStockOnly));

  type Row = {
    Plant: string;
    Size: string | number;
    Qty: string | number;
    Price: string | number;
    Photo: string;
    'Photo URL': string;
  };

  const rows: Row[] = [];
  /** Excel row index (1-based data rows; header is row 0) → plant for photo hyperlinks */
  const photoBySheetRow = new Map<number, InventoryPlant>();

  for (const group of groups) {
    rows.push({
      Plant: group.category,
      Size: '',
      Qty: '',
      Price: '',
      Photo: '',
      'Photo URL': ''
    });
    for (const plant of group.plants) {
      const sheetRow = rows.length; // 0-based among data rows; +1 for header when linking
      rows.push({
        Plant: plant.plantName,
        Size: plant.containerSize || '',
        Qty: plant.quantityAvailable ?? 0,
        Price: plant.listPrice != null ? plant.listPrice : '',
        Photo: isHttpUrl(plant.photoUrl) ? 'View photo' : '',
        'Photo URL': isHttpUrl(plant.photoUrl) ? plant.photoUrl : ''
      });
      photoBySheetRow.set(sheetRow, plant);
    }
  }

  const sheet = XLSX.utils.json_to_sheet(
    rows.length
      ? rows
      : [{ Plant: '', Size: '', Qty: '', Price: '', Photo: '', 'Photo URL': '' }]
  );

  // Clickable "View photo" cells (column E = index 4)
  for (const [sheetRow, plant] of photoBySheetRow) {
    if (!isHttpUrl(plant.photoUrl)) continue;
    const cellRef = XLSX.utils.encode_cell({ r: sheetRow + 1, c: 4 });
    sheet[cellRef] = {
      t: 's',
      v: 'View photo',
      l: { Target: plant.photoUrl, Tooltip: plant.plantName }
    };
  }

  sheet['!cols'] = [
    { wch: 32 },
    { wch: 10 },
    { wch: 8 },
    { wch: 10 },
    { wch: 12 },
    { wch: 48 }
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Availability');
  const fileName = `${safeFileStem(params.nurseryName)}_availability.xlsx`;
  XLSX.writeFile(workbook, fileName);
}

/** Build a PDF availability list with clickable photo links. */
export async function exportAvailabilityPdf(params: {
  nurseryName: string;
  plants: InventoryPlant[];
  inStockOnly?: boolean;
}): Promise<PdfDelivery> {
  const groups = groupPlantsByCategory(filterExportPlants(params.plants, params.inStockOnly));

  const pdf = new jsPDF('p', 'pt', 'letter');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 40;
  const rightX = pageWidth - margin;
  let y = margin;

  const ensureSpace = (need: number) => {
    if (y + need <= pageHeight - margin) return;
    pdf.addPage();
    y = margin;
    drawHeaderRow();
  };

  const drawHeaderRow = () => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 116, 139);
    pdf.text('PLANT', margin, y);
    pdf.text('SIZE', margin + 220, y);
    pdf.text('QTY', margin + 300, y, { align: 'right' });
    pdf.text('PRICE', margin + 360, y, { align: 'right' });
    pdf.text('PHOTO', rightX, y, { align: 'right' });
    y += 4;
    pdf.setDrawColor(203, 213, 225);
    pdf.setLineWidth(1);
    pdf.line(margin, y, rightX, y);
    y += 14;
  };

  const drawCategoryHeading = (category: string) => {
    ensureSpace(28);
    y += 6;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(14, 116, 144);
    pdf.text(category.toUpperCase(), margin, y);
    y += 4;
    pdf.setDrawColor(14, 116, 144);
    pdf.setLineWidth(1.25);
    pdf.line(margin, y, rightX, y);
    y += 14;
  };

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor(14, 116, 144);
  pdf.text((params.nurseryName || 'Nursery').toUpperCase(), margin, y);
  y += 16;
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text('CURRENT AVAILABILITY', margin, y);
  y += 12;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Click “View photo” to open a plant photo in your browser.', margin, y);
  y += 18;

  drawHeaderRow();

  if (groups.length === 0) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(100, 116, 139);
    pdf.text('No plants to list.', margin, y);
  } else {
    for (const group of groups) {
      drawCategoryHeading(group.category);

      for (const plant of group.plants) {
        const nameLines = pdf.splitTextToSize(plant.plantName || '—', 200);
        const rowH = Math.max(16, nameLines.length * 11 + 6);
        ensureSpace(rowH + 4);

        const baseline = y;
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(15, 23, 42);
        nameLines.forEach((line: string, i: number) => {
          pdf.text(line, margin, baseline + i * 11);
        });

        pdf.setFontSize(9);
        pdf.setTextColor(71, 85, 105);
        pdf.text(String(plant.containerSize || ''), margin + 220, baseline);
        pdf.setTextColor(15, 23, 42);
        pdf.text(String(plant.quantityAvailable ?? 0), margin + 300, baseline, { align: 'right' });
        pdf.text(money(plant.listPrice), margin + 360, baseline, { align: 'right' });

        if (isHttpUrl(plant.photoUrl)) {
          pdf.setTextColor(14, 116, 144);
          pdf.setFont('helvetica', 'bold');
          pdf.textWithLink('View photo', rightX, baseline, {
            align: 'right',
            url: plant.photoUrl
          });
          pdf.setFont('helvetica', 'normal');
        } else {
          pdf.setTextColor(148, 163, 184);
          pdf.text('—', rightX, baseline, { align: 'right' });
        }

        y = baseline + rowH;
        pdf.setDrawColor(241, 245, 249);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y - 4, rightX, y - 4);
      }
    }
  }

  const fileName = `${safeFileStem(params.nurseryName)}_availability.pdf`;
  return deliverPdfBlob(pdf.output('blob'), fileName);
}
