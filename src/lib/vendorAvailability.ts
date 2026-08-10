import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { VendorAvailabilityLine } from '../types';
import {
  parseInventoryCsvText,
  parseInventorySpreadsheetArrayBuffer,
  SpreadsheetInventoryItem
} from './inventorySpreadsheet';
import { normalizePlantName, plantNamesMatch } from './inventoryMatch';

let activeTenantId: string | null = null;

export function setVendorAvailabilityTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function availabilityCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'vendorAvailabilityLines');
}

function availabilityDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'vendorAvailabilityLines', id);
}

function sanitizeForFirestore<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForFirestore(item)) as T;
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value === undefined) continue;
      result[key] = sanitizeForFirestore(value);
    }
    return result as T;
  }
  return data;
}

export function subscribeToVendorAvailabilityLines(
  callback: (lines: VendorAvailabilityLine[]) => void
) {
  const tenantId = requireTenantId();
  const q = query(availabilityCol(tenantId), orderBy('plantName', 'asc'));
  return onSnapshot(
    q,
    (snap) => {
      const lines: VendorAvailabilityLine[] = [];
      snap.forEach((docSnap) => {
        lines.push({
          id: docSnap.id,
          ...(docSnap.data() as Omit<VendorAvailabilityLine, 'id'>)
        });
      });
      callback(lines);
    },
    (err) => {
      console.error('vendorAvailability subscribe failed', err);
      callback([]);
    }
  );
}

async function deleteLinesForVendor(tenantId: string, vendorId: string): Promise<number> {
  const q = query(availabilityCol(tenantId), where('vendorId', '==', vendorId));
  const snap = await getDocs(q);
  if (snap.empty) return 0;
  let deleted = 0;
  let batch = writeBatch(db);
  let ops = 0;
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
    ops += 1;
    deleted += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return deleted;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const PDF_PARSE_TIMEOUT_MS = 360_000;

function inferAvailabilityMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'csv':
    case 'txt':
      return 'text/csv';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    default:
      return 'application/octet-stream';
  }
}

function isSpreadsheetAvailabilityFile(file: File, mimeType: string): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.csv') ||
    name.endsWith('.txt') ||
    name.endsWith('.tsv') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    mimeType === 'text/csv' ||
    mimeType === 'text/plain' ||
    mimeType === 'text/tab-separated-values' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType.includes('sheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('csv')
  );
}

function isPdfAvailabilityFile(file: File, mimeType: string): boolean {
  return file.name.toLowerCase().endsWith('.pdf') || mimeType === 'application/pdf';
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mapAiItemsToSpreadsheetRows(rawItems: any[]): SpreadsheetInventoryItem[] {
  return rawItems
    .map((item) => {
      const plantName = String(item?.plantName || '').trim();
      if (!plantName) return null;
      const listPriceRaw = item?.listPrice ?? item?.unitPrice ?? item?.price;
      const listPrice =
        listPriceRaw == null || listPriceRaw === ''
          ? null
          : Number(listPriceRaw);
      return {
        plantName,
        containerSize: String(item?.containerSize || item?.size || 'Other').trim() || 'Other',
        quantityAvailable: Number(item?.quantityAvailable ?? item?.quantity ?? 0) || 0,
        location: item?.location ? String(item.location) : undefined,
        category: item?.category ? String(item.category) : undefined,
        listPrice: Number.isFinite(listPrice as number) ? (listPrice as number) : null,
        notes: item?.notes ? String(item.notes) : '',
        chemicals: [] as [],
        fertilizers: [] as [],
        cutBackAt: null
      } satisfies SpreadsheetInventoryItem;
    })
    .filter(Boolean) as SpreadsheetInventoryItem[];
}

async function parseAvailabilityPdf(
  file: File,
  onStatus?: (message: string) => void
): Promise<SpreadsheetInventoryItem[]> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('PDF is too large. Keep files under 20 MB.');
  }
  onStatus?.('Reading PDF…');
  const base64Data = await fileToDataUrl(file);
  onStatus?.('Analyzing PDF with AI (large lists may take a few minutes)…');

  let response: Response;
  try {
    response = await fetchWithTimeout(
      '/api/parse-inventory',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Data,
          mimeType: 'application/pdf',
          fileName: file.name
        })
      },
      PDF_PARSE_TIMEOUT_MS
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(
        'PDF analysis timed out. Try again, or export the list as CSV/Excel.'
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error ||
        (typeof errorData.details === 'string' ? errorData.details : null) ||
        'Could not read plants from that PDF.'
    );
  }

  const result = await response.json();
  const rawItems = Array.isArray(result?.items) ? result.items : [];
  const rows = mapAiItemsToSpreadsheetRows(rawItems);
  if (rows.length === 0) {
    throw new Error('No plants detected in that PDF.');
  }
  return rows;
}

/** Parse CSV, Excel, or PDF vendor availability / price lists. */
export async function parseVendorAvailabilityFile(
  file: File,
  onStatus?: (message: string) => void
): Promise<SpreadsheetInventoryItem[]> {
  const mimeType = inferAvailabilityMimeType(file);
  const name = file.name.toLowerCase();

  if (isSpreadsheetAvailabilityFile(file, mimeType)) {
    if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv') || mimeType.includes('csv') || mimeType.includes('tab-separated') || mimeType === 'text/plain') {
      onStatus?.('Reading CSV…');
      const text = await file.text();
      return parseInventoryCsvText(text);
    }
    onStatus?.('Reading Excel…');
    const buf = await file.arrayBuffer();
    return parseInventorySpreadsheetArrayBuffer(buf, file.name);
  }

  if (isPdfAvailabilityFile(file, mimeType)) {
    return parseAvailabilityPdf(file, onStatus);
  }

  throw new Error('Use a CSV, Excel (.xlsx/.xls), or PDF availability file.');
}

/**
 * Replace this vendor's previous availability with a new spreadsheet upload.
 * Returns how many lines were saved.
 */
export async function replaceVendorAvailabilityFromUpload(params: {
  vendorId: string;
  vendorName: string;
  file: File;
  rows: SpreadsheetInventoryItem[];
}): Promise<{ imported: number; replaced: number; batchId: string }> {
  const tenantId = requireTenantId();
  const now = new Date().toISOString();
  const batchId = `avail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const replaced = await deleteLinesForVendor(tenantId, params.vendorId);

  let imported = 0;
  let batch = writeBatch(db);
  let ops = 0;

  for (const row of params.rows) {
    const plantName = String(row.plantName || '').trim();
    if (!plantName) continue;
    const id = `${batchId}-${imported}`;
    const line: VendorAvailabilityLine = {
      id,
      vendorId: params.vendorId,
      vendorName: params.vendorName,
      plantName,
      containerSize: String(row.containerSize || 'Other').trim() || 'Other',
      quantityAvailable: Number(row.quantityAvailable) || 0,
      listPrice: row.listPrice ?? null,
      location: row.location,
      category: row.category,
      notes: row.notes || undefined,
      sourceFileName: params.file.name,
      importBatchId: batchId,
      importedAt: now,
      createdAt: now,
      updatedAt: now
    };
    batch.set(availabilityDoc(tenantId, id), sanitizeForFirestore(line));
    ops += 1;
    imported += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { imported, replaced, batchId };
}

export async function clearVendorAvailability(vendorId: string): Promise<number> {
  const tenantId = requireTenantId();
  return deleteLinesForVendor(tenantId, vendorId);
}

/** Search uploaded vendor availabilities — exact, contains, and close name matches. */
export function searchVendorAvailabilityLines(
  lines: VendorAvailabilityLine[],
  rawQuery: string
): VendorAvailabilityLine[] {
  const q = normalizePlantName(rawQuery);
  if (!q) return lines;

  const scored: Array<{ line: VendorAvailabilityLine; score: number }> = [];
  for (const line of lines) {
    const name = normalizePlantName(line.plantName);
    const size = normalizePlantName(line.containerSize);
    const vendor = normalizePlantName(line.vendorName);
    const category = normalizePlantName(line.category || '');
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 90;
    else if (name.includes(q)) score = 80;
    else if (plantNamesMatch(q, line.plantName)) score = 70;
    else if (size.includes(q) || vendor.includes(q) || category.includes(q)) score = 40;
    else {
      const qWords = q.split(' ').filter(Boolean);
      const nameWords = new Set(name.split(' ').filter(Boolean));
      const hit = qWords.filter((w) => [...nameWords].some((n) => n.includes(w) || w.includes(n)));
      if (hit.length > 0 && hit.length >= Math.ceil(qWords.length * 0.5)) {
        score = 30 + hit.length * 5;
      }
    }
    if (score > 0) scored.push({ line, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.line.plantName.localeCompare(b.line.plantName);
  });
  return scored.map((s) => s.line);
}
