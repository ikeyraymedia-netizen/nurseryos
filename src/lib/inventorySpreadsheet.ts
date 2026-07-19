/**
 * Inventory spreadsheet parsers:
 * 1) Standard tables (Plant / Size / Qty headers)
 * 2) Nursery price-catalog matrices (size columns + priced plant rows)
 */

export type SpreadsheetInventoryItem = {
  plantName: string;
  containerSize: string;
  quantityAvailable: number;
  weeksUntilReady: number | null;
  location?: string;
  category?: string;
  listPrice?: number | null;
  notes: string;
  chemicals: [];
  cutBackAt: null;
};

const SECTION_HEADERS = new Set([
  'ground cover',
  'ground covers',
  'shrubs',
  'shrub',
  'trees',
  'tree',
  'perennials',
  'perennial',
  'grasses',
  'grass',
  'vines',
  'vine',
  'annuals',
  'annual',
  'fruit',
  'fruits',
  'edibles',
  'conifers',
  'natives',
  'specialty',
  'misc',
  'miscellaneous'
]);

function detectCsvDelimiter(headerLine: string): string {
  const comma = (headerLine.match(/,/g) || []).length;
  const semi = (headerLine.match(/;/g) || []).length;
  const tab = (headerLine.match(/\t/g) || []).length;
  if (tab >= comma && tab >= semi && tab > 0) return '\t';
  if (semi > comma) return ';';
  return ',';
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeaderCell(value: string): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function headerMatchesAlias(header: string, alias: string): boolean {
  if (header === alias) return true;
  // Avoid false positives like "bayoustateplantco" matching "plant" or "bay".
  if (alias.length <= 4) {
    return new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(
      header
    );
  }
  return header.includes(alias);
}

function pickColumn(headers: string[], aliasGroups: string[][]): number {
  for (const aliases of aliasGroups) {
    for (const alias of aliases) {
      const exact = headers.findIndex((h) => h === alias);
      if (exact >= 0) return exact;
    }
    for (const alias of aliases) {
      const partial = headers.findIndex((h) => headerMatchesAlias(h, alias));
      if (partial >= 0) return partial;
    }
  }
  return -1;
}

function parseQty(raw: string): number {
  const cleaned = String(raw || '').replace(/,/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function mapTableToInventory(table: string[][]): SpreadsheetInventoryItem[] {
  if (table.length < 2) return [];

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(table.length, 25); i += 1) {
    const headers = table[i].map(normalizeHeaderCell);
    // Ignore long banner/contact rows pretending to be headers.
    if (headers.some((h) => h.length > 48)) continue;

    const nameIdx = pickColumn(headers, [
      ['plant name', 'plant', 'botanical name', 'botanical', 'species', 'variety', 'cultivar'],
      ['description', 'item description', 'product name', 'product', 'item'],
      ['name']
    ]);
    const qtyIdx = pickColumn(headers, [
      ['qty available', 'quantity available', 'on hand', 'available', 'qty', 'quantity', 'stock', 'count']
    ]);
    const sizeIdx = pickColumn(headers, [
      ['container size', 'container', 'pot size', 'size', 'gallon', 'caliper']
    ]);
    // Require a real inventory table shape (name + qty or size), not a price catalog.
    if (nameIdx >= 0 && (qtyIdx >= 0 || sizeIdx >= 0)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return [];

  const headers = table[headerRowIdx].map(normalizeHeaderCell);
  const nameIdx = pickColumn(headers, [
    ['plant name', 'plant', 'botanical name', 'botanical', 'species', 'variety', 'cultivar'],
    ['description', 'item description', 'product name', 'product', 'item'],
    ['name']
  ]);
  if (nameIdx < 0) return [];

  const sizeIdx = pickColumn(headers, [
    ['container size', 'container', 'pot size', 'size', 'gallon', 'caliper', 'pot']
  ]);
  const qtyIdx = pickColumn(headers, [
    [
      'qty available',
      'quantity available',
      'on hand',
      'available',
      'qty',
      'quantity',
      'stock',
      'count',
      'inventory'
    ]
  ]);
  const weeksIdx = pickColumn(headers, [['weeks until ready', 'weeks', 'week', 'ready']]);
  const locationIdx = pickColumn(headers, [
    ['location', 'bed', 'block', 'bay', 'zone', 'aisle', 'house', 'yard']
  ]);
  const notesIdx = pickColumn(headers, [['notes', 'note', 'comment', 'remarks', 'memo']]);

  const out: SpreadsheetInventoryItem[] = [];
  for (const row of table.slice(headerRowIdx + 1)) {
    const plantName = String(row[nameIdx] || '').trim();
    if (!plantName) continue;
    if (normalizeHeaderCell(plantName) === headers[nameIdx]) continue;

    const entry: SpreadsheetInventoryItem = {
      plantName,
      containerSize: sizeIdx >= 0 ? String(row[sizeIdx] || '').trim() || 'Other' : 'Other',
      quantityAvailable: qtyIdx >= 0 ? parseQty(row[qtyIdx]) : 0,
      weeksUntilReady:
        weeksIdx >= 0 && String(row[weeksIdx] || '').trim()
          ? Number(String(row[weeksIdx]).replace(/[^\d.-]/g, '')) || null
          : null,
      chemicals: [],
      cutBackAt: null,
      notes: notesIdx >= 0 ? String(row[notesIdx] || '').trim() : ''
    };
    if (locationIdx >= 0 && String(row[locationIdx] || '').trim()) {
      entry.location = String(row[locationIdx]).trim();
    }
    out.push(entry);
  }
  return out;
}

function normalizeSizeToken(raw: string): string | null {
  const t = String(raw || '')
    .trim()
    .replace(/\u201d/g, '"')
    .replace(/\u201c/g, '"')
    .replace(/\u2033/g, '"');
  if (!t) return null;

  const lower = t.toLowerCase();
  if (/^#?\s*1\b/.test(lower) || /^1\s*g(al(lon)?)?$/.test(lower)) return '#1';
  if (/^#?\s*3\b/.test(lower) || /^3\s*g(al(lon)?)?$/.test(lower)) return '#3';
  if (/^#?\s*5\b/.test(lower) || /^5\s*g(al(lon)?)?$/.test(lower)) return '#5';
  if (/^#?\s*7\b/.test(lower) || /^7\s*g(al(lon)?)?$/.test(lower)) return '#7';
  if (/^#?\s*10\b/.test(lower) || /^10\s*g(al(lon)?)?$/.test(lower)) return '#10';
  if (/^#?\s*15\b/.test(lower) || /^15\s*g(al(lon)?)?$/.test(lower)) return '#15';
  if (/^#?\s*30\b/.test(lower) || /^30\s*g(al(lon)?)?$/.test(lower)) return '#30';
  if (/^#?\s*45\b/.test(lower) || /^45\s*g(al(lon)?)?$/.test(lower)) return '#45';
  if (/^(b\s*&\s*b|b and b|bb)$/i.test(lower)) return 'B&B';
  if (/^4\s*("|in|inch)?$/i.test(lower)) return '4 inch';
  if (/^6\s*("|in|inch)?$/i.test(lower)) return '6 inch';
  if (/^(tray|flat|plug)$/i.test(lower)) return 'Tray';
  if (/^#\d+/.test(t)) return t.replace(/\s+/g, '');
  return null;
}

function isSizeToken(raw: string): boolean {
  return normalizeSizeToken(raw) != null;
}

function isPriceToken(raw: string): boolean {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (/^\$?\s*\d{1,4}([.,]\d{1,2})?$/.test(t.replace(/,/g, ''))) return true;
  return /^\$/.test(t);
}

function titleCaseWords(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function parsePriceNumber(raw: string): number | null {
  const cleaned = String(raw || '').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isBoilerplateRow(label: string): boolean {
  return /catalog|availability|pricing|confirm|www\.|contact|@|^\*|phone|^\d{3}[-.]/i.test(label);
}

function isSectionHeader(label: string): boolean {
  const n = normalizeHeaderCell(label);
  return Boolean(n) && SECTION_HEADERS.has(n);
}

function looksLikeGenusHeader(label: string): boolean {
  const t = String(label || '').trim();
  if (!t || t.length > 48) return false;
  if (isSectionHeader(t) || isBoilerplateRow(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  return t === t.toUpperCase() && /[A-Z]/.test(t);
}

function buildCatalogPlantName(genus: string | null, variety: string): string {
  const v = variety.trim().replace(/\s+/g, ' ');
  if (!genus) return v;
  const gNorm = normalizeHeaderCell(genus);
  const vNorm = normalizeHeaderCell(v);
  if (vNorm === gNorm || vNorm.startsWith(`${gNorm} `)) return titleCaseWords(v);
  if (gNorm.split(/\s+/).every((w) => vNorm.includes(w))) return titleCaseWords(v);
  return `${genus} ${v}`.replace(/\s+/g, ' ').trim();
}

/**
 * Parse nursery price-list matrices like Bayou/SiteOne catalogs:
 * section banners, genus + size headers, then plant rows with $ prices.
 */
export function parseCatalogMatrix(table: string[][]): SpreadsheetInventoryItem[] {
  let sizesByCol: Record<number, string> = {};
  let genusPrefix: string | null = null;
  let section: string | null = null;
  const out: SpreadsheetInventoryItem[] = [];
  const seen = new Set<string>();

  for (const row of table) {
    const cells = (row || []).map((c) => String(c ?? '').trim());
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;

    const label = cells[0] || '';
    const sizeCols: Array<{ idx: number; size: string }> = [];
    const priceCols: Array<{ idx: number; price: string }> = [];

    for (let i = 1; i < cells.length; i += 1) {
      const cell = cells[i];
      if (!cell) continue;
      const size = normalizeSizeToken(cell);
      if (size) sizeCols.push({ idx: i, size });
      else if (isPriceToken(cell)) priceCols.push({ idx: i, price: cell });
    }

    if (label && isBoilerplateRow(label) && priceCols.length === 0) continue;

    // Pure section banner (GROUND COVER, SHRUBS, …)
    if (label && isSectionHeader(label) && sizeCols.length === 0 && priceCols.length === 0) {
      section = titleCaseWords(label);
      genusPrefix = null;
      continue;
    }

    // Size header row (optionally with genus or section name in col 0)
    if (sizeCols.length > 0 && priceCols.length === 0) {
      sizesByCol = {};
      for (const s of sizeCols) sizesByCol[s.idx] = s.size;

      if (label && isSectionHeader(label)) {
        section = titleCaseWords(label);
        genusPrefix = null;
      } else if (label && looksLikeGenusHeader(label)) {
        genusPrefix = titleCaseWords(label);
      } else if (!label) {
        // keep genus; blank size-only header (ground cover 4" / #1)
      }
      continue;
    }

    // Plant / variety row with prices under active size columns
    if (label && priceCols.length > 0 && Object.keys(sizesByCol).length > 0) {
      if (isSectionHeader(label) || looksLikeGenusHeader(label) || isBoilerplateRow(label)) {
        continue;
      }

      const plantName = buildCatalogPlantName(genusPrefix, label);

      for (const p of priceCols) {
        const size = sizesByCol[p.idx];
        if (!size) continue;
        const listPrice = parsePriceNumber(p.price);
        const key = `${normalizeHeaderCell(plantName)}::${size}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const entry: SpreadsheetInventoryItem = {
          plantName,
          containerSize: size,
          quantityAvailable: 0,
          weeksUntilReady: null,
          chemicals: [],
          cutBackAt: null,
          listPrice,
          notes: listPrice != null ? `List price $${listPrice.toFixed(2)}` : ''
        };
        if (section) entry.category = section;
        out.push(entry);
      }
    }
  }

  return out;
}

export function parseInventoryTable(table: string[][]): SpreadsheetInventoryItem[] {
  const standard = mapTableToInventory(table);
  if (standard.length > 0) return standard;
  return parseCatalogMatrix(table);
}

export function parseInventoryCsvText(text: string): SpreadsheetInventoryItem[] {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];
  const rawLines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length < 2) return [];
  const delimiter = detectCsvDelimiter(rawLines[0]);
  const table = rawLines.map((line) => splitCsvLine(line, delimiter));
  return parseInventoryTable(table);
}

export async function parseInventorySpreadsheetArrayBuffer(
  buffer: ArrayBuffer | Buffer,
  fileName?: string
): Promise<SpreadsheetInventoryItem[]> {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv')) {
    const text =
      typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)
        ? buffer.toString('utf8')
        : new TextDecoder('utf-8').decode(buffer as ArrayBuffer);
    return parseInventoryCsvText(text);
  }

  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(sheet, {
    header: 1,
    defval: '',
    raw: false
  }) as (string | number | null | undefined)[][];
  const table = rows.map((row) => (Array.isArray(row) ? row : []).map((c) => String(c ?? '').trim()));
  return parseInventoryTable(table);
}

export function isSpreadsheetInventoryUpload(mimeType: string, fileName?: string): boolean {
  const name = String(fileName || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  return (
    name.endsWith('.csv') ||
    name.endsWith('.tsv') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    mime.includes('csv') ||
    mime.includes('tab-separated') ||
    mime.includes('spreadsheet') ||
    mime === 'application/vnd.ms-excel'
  );
}
