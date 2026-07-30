export interface ParsedOrderItem {
  plantName: string;
  containerSize: string;
  quantity: number;
  notes?: string;
}

export interface ParsedOrderFromText {
  customerName: string;
  orderNumber: string;
  items: ParsedOrderItem[];
  plainText: string;
}

const SIZE_RULES: Array<{ size: string; re: RegExp }> = [
  { size: 'B&B', re: /\b(?:b\s*&\s*b|b\.?\s*&?\s*b\.?|balled(?:\s+and\s+burlapped)?)\b/i },
  { size: '#100', re: /(?:#\s*100\b|\b100\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#65', re: /(?:#\s*65\b|\b65\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#45', re: /(?:#\s*45\b|\b45\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#30', re: /(?:#\s*30\b|\b30\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#15', re: /(?:#\s*15\b|\b15\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#10', re: /(?:#\s*10\b|\b10\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#7', re: /(?:#\s*7\b|\b7\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#5', re: /(?:#\s*5\b|\b5\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#3', re: /(?:#\s*3\b|\b3\s*g(?:al(?:lon)?)?\b)/i },
  { size: '#1', re: /(?:#\s*1\b|\b1\s*g(?:al(?:lon)?)?\b|\bno\.?\s*1\b)/i },
  { size: '6 inch', re: /\b6\s*(?:inch|in|"|'')\b/i },
  { size: '4 inch', re: /\b4\s*(?:inch|in|"|'')\b/i },
  { size: 'Tray', re: /\b(?:tray|flat|plug\s*tray)\b/i }
];

/** Caliper / B&B height notes like 24", 30", 2.5" cal. */
function noteSizePattern(): RegExp {
  return /\b(\d+(?:\.\d+)?)\s*(?:["”]|''|in(?:ch(?:es)?)?|cal(?:iper)?\.?)(?=\s|$|[^a-z0-9])/gi;
}

function standardizeContainerSize(raw: string): string {
  const text = raw.trim();
  for (const rule of SIZE_RULES) {
    if (rule.re.test(text)) return rule.size;
  }
  // Bare inch sizes (common on B&B) — keep as quoted size when no pot size present.
  const inchOnly = text.match(/^\s*(\d+(?:\.\d+)?)\s*(?:["”]|''|in(?:ch(?:es)?)?)\s*$/i);
  if (inchOnly) return `${inchOnly[1]}"`;
  return 'Other';
}

function extractNotes(raw: string): string | undefined {
  const notes: string[] = [];
  const inchMatches = raw.match(noteSizePattern());
  if (inchMatches) {
    for (const m of inchMatches) {
      const cleaned = m.replace(/\s+/g, ' ').trim();
      if (!notes.includes(cleaned)) notes.push(cleaned);
    }
  }
  // Parenthetical notes: (special grade)
  const paren = raw.match(/\(([^)]+)\)/g);
  if (paren) {
    for (const p of paren) {
      const inner = p.slice(1, -1).trim();
      if (inner && !/^\d+$/.test(inner) && !notes.includes(inner)) notes.push(inner);
    }
  }
  return notes.length ? notes.join(' · ') : undefined;
}

function stripSizeTokens(raw: string): string {
  let name = raw.trim();
  for (const rule of SIZE_RULES) {
    name = name.replace(rule.re, ' ');
  }
  name = name.replace(noteSizePattern(), ' ');
  name = name.replace(/\([^)]*\)/g, ' ');
  return name
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-–—,.:#]+|[-–—,.:#]+$/g, '')
    .trim();
}

function extractMeta(lines: string[]): { customerName: string; orderNumber: string } {
  let customerName = 'Unknown Customer';
  let orderNumber = 'N/A';

  for (const line of lines) {
    const customerMatch = line.match(
      /^(?:customer|bill\s*to|ship\s*to|client|company)\s*[:\-]\s*(.+)$/i
    );
    if (customerMatch?.[1]?.trim()) {
      customerName = customerMatch[1].trim();
      continue;
    }
    const orderMatch = line.match(
      /^(?:po|p\.?o\.?|order|invoice|ticket)\s*(?:#|number|no\.?)?\s*[:\-#]?\s*(.+)$/i
    );
    if (orderMatch?.[1]?.trim()) {
      orderNumber = orderMatch[1].trim();
    }
  }

  return { customerName, orderNumber };
}

function isMetaOrJunkLine(line: string): boolean {
  return /^(customer|bill\s*to|ship\s*to|client|company|po|order|invoice|notes?|qty|quantity|plant|size|description|item|total|subtotal|tax|date|page)\b/i.test(
    line
  );
}

function buildItem(quantity: number, rest: string): ParsedOrderItem | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || !rest.trim()) return null;
  const containerSize = standardizeContainerSize(rest);
  const plantName = stripSizeTokens(rest) || rest.trim();
  if (!plantName || plantName.length < 2) return null;
  // Avoid treating bare numbers / sizes as plant names
  if (/^[\d#"\s.]+$/.test(plantName)) return null;

  const notes = extractNotes(rest);
  return {
    plantName,
    containerSize: containerSize || 'Other',
    quantity,
    ...(notes ? { notes } : {})
  };
}

function parseTabularLine(line: string): ParsedOrderItem | null {
  const parts = line
    .split(/\t+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  // qty first: 171 | Wintergreen | B&B | 24"
  if (/^\d+$/.test(parts[0])) {
    const quantity = parseInt(parts[0], 10);
    const rest = parts.slice(1).join(' ');
    return buildItem(quantity, rest);
  }

  // qty last: Wintergreen | B&B | 24" | 171
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    const quantity = parseInt(last, 10);
    const rest = parts.slice(0, -1).join(' ');
    return buildItem(quantity, rest);
  }

  return null;
}

function parseCsvishLine(line: string): ParsedOrderItem | null {
  if (!line.includes(',')) return null;
  const parts = line
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (/^\d+$/.test(parts[0])) {
    return buildItem(parseInt(parts[0], 10), parts.slice(1).join(' '));
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    return buildItem(parseInt(last, 10), parts.slice(0, -1).join(' '));
  }
  return null;
}

/**
 * Split a single line that contains multiple "qty + plant" segments, e.g.
 * `171 Wintergreen B&B 24" 5 Holly #7 25 Boxwood #3`
 */
function explodeMultiQtyLine(line: string): string[] {
  const cleaned = line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim();
  if (!cleaned) return [];

  // Need at least two leading-qty plant chunks
  const starts: number[] = [];
  const re = /(?:^|\s)(\d+)\s+(?=[A-Za-z(#])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const idx = m.index + (m[0].startsWith(' ') || m[0].startsWith('\t') ? 1 : 0);
    starts.push(idx);
  }

  if (starts.length < 2) return [cleaned];

  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : cleaned.length;
    const chunk = cleaned.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [cleaned];
}

function parseLineItem(line: string): ParsedOrderItem | null {
  const cleaned = line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (isMetaOrJunkLine(cleaned)) return null;

  const tabular = parseTabularLine(cleaned);
  if (tabular) return tabular;

  const csvish = parseCsvishLine(cleaned);
  if (csvish) return csvish;

  const patterns: Array<RegExp> = [
    /^(\d+)\s*[-x×]\s*(.+)$/i,
    /^(\d+)\s+(.+)$/,
    /^(.+?)\s*[-–—]\s*(\d+)\s*$/,
    /^(.+?)\s*[x×]\s*(\d+)\s*$/i,
    /^(.+?)\s*\((\d+)\)\s*$/,
    // Trailing qty with spaces (Excel / Word paste): "Wintergreen B&B 24" 171"
    /^(.+?)\s+(\d+)\s*$/
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;

    const first = match[1].trim();
    const second = match[2].trim();
    const qtyFirst = /^\d+$/.test(first);
    const quantity = parseInt(qtyFirst ? first : second, 10);
    const rest = qtyFirst ? second : first;

    // Don't treat "#15" / trailing container numbers as quantity.
    if (!qtyFirst) {
      if (/#\s*$/.test(rest) || new RegExp(`#\\s*${quantity}\\b`, 'i').test(cleaned)) {
        continue;
      }
      // Lone size-like trailing numbers on very short plant text are usually sizes, not qty.
      if (rest.length < 3) continue;
    }

    const item = buildItem(quantity, rest);
    if (item) return item;
  }

  return null;
}

function buildPlainTextChecklist(
  customerName: string,
  orderNumber: string,
  items: ParsedOrderItem[]
): string {
  const header = [
    `CUSTOMER: ${customerName}`,
    orderNumber !== 'N/A' ? `ORDER/PO: ${orderNumber}` : null,
    ''
  ].filter(Boolean);

  const lines = items.map(
    (item) =>
      `[ ] ${item.quantity} × ${item.containerSize}  ${item.plantName}${
        item.notes ? `  (${item.notes})` : ''
      }`
  );

  return [...header, ...lines].join('\n');
}

/** Count standalone qty tokens that look like line quantities (1–99999). */
export function countLikelyQtyTokens(text: string): number {
  const matches = String(text || '').match(/(?:^|[\s,;|])(\d{1,5})(?=[\s,;|]|$)/gm);
  return matches ? matches.length : 0;
}

/** Fast local parse for pasted plain-text orders (no AI required). */
export function parseOrderTextLocally(rawText: string): ParsedOrderFromText | null {
  const text = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // If the paste collapsed to one/few lines, also try splitting on semicolons.
  const expanded: string[] = [];
  for (const line of rawLines) {
    if (line.includes(';') && (line.match(/;/g) || []).length >= 1 && /\d/.test(line)) {
      for (const part of line.split(';')) {
        const t = part.trim();
        if (t) expanded.push(t);
      }
    } else {
      expanded.push(line);
    }
  }

  const candidateLines: string[] = [];
  for (const line of expanded) {
    for (const chunk of explodeMultiQtyLine(line)) {
      candidateLines.push(chunk);
    }
  }

  const { customerName, orderNumber } = extractMeta(rawLines);
  const items: ParsedOrderItem[] = [];

  for (const line of candidateLines) {
    const item = parseLineItem(line);
    if (item) items.push(item);
  }

  if (items.length === 0) return null;

  return {
    customerName,
    orderNumber,
    items,
    plainText: buildPlainTextChecklist(customerName, orderNumber, items)
  };
}

/**
 * True when local parse likely missed lines (e.g. only 1 item but many qty tokens).
 * Caller can fall through to AI in that case.
 */
export function localParseLooksIncomplete(
  rawText: string,
  local: ParsedOrderFromText | null
): boolean {
  if (!local || local.items.length === 0) return true;
  const qtyTokens = countLikelyQtyTokens(rawText);
  if (local.items.length === 1 && qtyTokens >= 3) return true;
  if (qtyTokens >= local.items.length * 2 + 2) return true;
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isMetaOrJunkLine(l));
  if (lines.length >= 4 && local.items.length === 1) return true;
  return false;
}

export function decodeBase64Text(base64Data: string): string {
  const clean = String(base64Data || '').replace(/^data:.*?;base64,/, '');
  return Buffer.from(clean, 'base64').toString('utf8');
}

export function isPlainTextMime(mimeType: string | undefined | null): boolean {
  const mime = String(mimeType || '').toLowerCase();
  return mime === 'text/plain' || mime.startsWith('text/');
}
