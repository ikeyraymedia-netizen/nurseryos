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
  { size: 'B&B', re: /\b(?:b\s*&\s*b|b\.?\s*&?\s*b\.?|balled(?:\s+and\s+burlapped)?|caliper)\b/i },
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

function standardizeContainerSize(raw: string): string {
  const text = raw.trim();
  for (const rule of SIZE_RULES) {
    if (rule.re.test(text)) return rule.size;
  }
  return text || 'Other';
}

function stripSizeTokens(raw: string): string {
  let name = raw.trim();
  for (const rule of SIZE_RULES) {
    name = name.replace(rule.re, ' ');
  }
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

function parseLineItem(line: string): ParsedOrderItem | null {
  const cleaned = line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (/^(customer|bill\s*to|ship\s*to|client|company|po|order|invoice|notes?)\b/i.test(cleaned)) {
    return null;
  }

  const patterns: Array<RegExp> = [
    /^(\d+)\s*[-x×]\s*(.+)$/i,
    /^(\d+)\s+(.+)$/,
    /^(.+?)\s*[-–—]\s*(\d+)\s*$/,
    /^(.+?)\s*[x×]\s*(\d+)\s*$/i,
    /^(.+?)\s*\((\d+)\)\s*$/
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;

    const first = match[1].trim();
    const second = match[2].trim();
    const qtyFirst = /^\d+$/.test(first);
    const quantity = parseInt(qtyFirst ? first : second, 10);
    const rest = qtyFirst ? second : first;
    if (!Number.isFinite(quantity) || quantity <= 0 || !rest) continue;

    const containerSize = standardizeContainerSize(rest);
    const plantName = stripSizeTokens(rest) || rest;
    if (!plantName) continue;

    return {
      plantName,
      containerSize: containerSize || 'Other',
      quantity
    };
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

/** Fast local parse for pasted plain-text orders (no AI required). */
export function parseOrderTextLocally(rawText: string): ParsedOrderFromText | null {
  const text = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const { customerName, orderNumber } = extractMeta(lines);
  const items: ParsedOrderItem[] = [];

  for (const line of lines) {
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

export function decodeBase64Text(base64Data: string): string {
  const clean = String(base64Data || '').replace(/^data:.*?;base64,/, '');
  return Buffer.from(clean, 'base64').toString('utf8');
}

export function isPlainTextMime(mimeType: string | undefined | null): boolean {
  const mime = String(mimeType || '').toLowerCase();
  return mime === 'text/plain' || mime.startsWith('text/');
}
