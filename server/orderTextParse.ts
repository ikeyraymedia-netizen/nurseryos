export interface ParsedOrderItem {
  plantName: string;
  containerSize: string;
  quantity: number;
  notes?: string;
}

export interface ParsedOrderFromText {
  customerName: string;
  /** Customer PO when clearly labeled; empty otherwise. No invented order numbers. */
  poNumber: string;
  billingName?: string;
  billingAddress?: string;
  shippingName?: string;
  shippingAddress?: string;
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

/** Invoice / charge descriptions that are never plant lines. */
const NON_PLANT_NAME_RE =
  /^(?:freight|shipping|delivery|fuel(?:\s+surcharge)?|surcharge|handling|labor|install(?:ation)?|tax|sales\s*tax|vat|gst|hst|discount|deposit|payment|credit|refund|misc(?:ellaneous)?|fee|service(?:\s+fee)?|restock(?:ing)?|minimum|subtotal|total|balance|amount\s*due|due\s*upon\s*receipt|invoice|order|purchase\s*order|page|phone|fax|email|website|www)$/i;

/** Caliper / B&B height notes like 24", 30", 2.5" cal. */
function noteSizePattern(): RegExp {
  return /\b(\d+(?:\.\d+)?)\s*(?:["”]|''|in(?:ch(?:es)?)?|cal(?:iper)?\.?)(?=\s|$|[^a-z0-9])/gi;
}

function priceTokenPattern(): RegExp {
  return /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\b\d+\.\d{2}\b/g;
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
      const cleaned = m
        .replace(/\s+/g, ' ')
        .replace(/\bcal(?:iper)?\.?\s*$/i, '')
        .trim();
      if (cleaned && !notes.includes(cleaned)) notes.push(cleaned);
    }
  }
  // Parenthetical notes: (special grade) — skip pure prices
  const paren = raw.match(/\(([^)]+)\)/g);
  if (paren) {
    for (const p of paren) {
      const inner = p.slice(1, -1).trim();
      if (!inner || /^\d+$/.test(inner) || priceTokenPattern().test(inner)) continue;
      priceTokenPattern().lastIndex = 0;
      if (!notes.includes(inner)) notes.push(inner);
    }
  }
  return notes.length ? notes.join(' · ') : undefined;
}

/** Strip sizes, prices, units, and invoice noise so plantName is just the plant. */
function cleanPlantName(raw: string): string {
  let name = raw.trim();
  for (const rule of SIZE_RULES) {
    name = name.replace(rule.re, ' ');
  }
  name = name.replace(noteSizePattern(), ' ');
  name = name.replace(/\([^)]*\)/g, ' ');
  name = name.replace(priceTokenPattern(), ' ');
  // Leftover caliper / unit / invoice column words
  name = name.replace(
    /\b(?:cal(?:iper)?\.?|ea\.?|each|ext(?:ended)?|unit\s*price|price|amount|qty|quantity|description|item(?:\s*#)?|sku|code|loc(?:ation)?)\b/gi,
    ' '
  );
  name = name.replace(/[@=]/g, ' ');
  name = name
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-–—,.:#/"'\s]+|[-–—,.:#/"'\s]+$/g, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return name;
}

function extractMeta(lines: string[]): {
  customerName: string;
  poNumber: string;
  billingName: string;
  billingAddress: string;
  shippingName: string;
  shippingAddress: string;
} {
  let customerName = 'Unknown Customer';
  let poNumber = '';
  let billingName = '';
  let billingAddress = '';
  let shippingName = '';
  let shippingAddress = '';

  const isSectionHeader = (line: string) =>
    /^(?:bill\s*to|sold\s*to|invoice\s*to|ship\s*to|deliver(?:y)?\s*to|deliver\s*to|receiver|jobsite|customer|client|company|po|p\.?o\.?|purchase\s*order|order|invoice|qty|quantity|plant|size|description|item|total|subtotal|tax|date|page)\b/i.test(
      line
    );

  const captureAddressBlock = (
    startIndex: number,
    kind: 'bill' | 'ship'
  ): { name: string; address: string; nextIndex: number } => {
    const collected: string[] = [];
    let i = startIndex;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        if (collected.length > 0) break;
        i += 1;
        continue;
      }
      if (isSectionHeader(line) && collected.length > 0) break;
      // Stop when we hit a plant qty line
      if (/^\d+\s+[A-Za-z(#]/.test(line) && collected.length > 0) break;
      collected.push(line);
      i += 1;
      if (collected.length >= 6) break;
    }
    const name = collected[0] || '';
    const address =
      collected
        .slice(name ? 1 : 0)
        .join('\n')
        .trim() || (collected.length === 1 ? collected[0] : '');
    // If only one line and it looks like a street/city, treat whole thing as address
    const looksLikeAddress =
      /\d/.test(name) || /\b(?:st|street|ave|road|rd|blvd|ln|dr|suite|ste|box)\b/i.test(name);
    if (looksLikeAddress && collected.length === 1) {
      return { name: '', address: name, nextIndex: i };
    }
    if (kind === 'bill' || kind === 'ship') {
      return {
        name: looksLikeAddress ? '' : name,
        address: looksLikeAddress ? collected.join('\n') : address || name,
        nextIndex: i
      };
    }
    return { name, address, nextIndex: i };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const customerMatch = line.match(/^(?:customer|client|company)\s*[:\-]\s*(.+)$/i);
    if (customerMatch?.[1]?.trim()) {
      customerName = customerMatch[1].trim();
      continue;
    }

    const billInline = line.match(/^(?:bill\s*to|sold\s*to|invoice\s*to)\s*[:\-]\s*(.+)$/i);
    if (billInline?.[1]?.trim()) {
      const rest = billInline[1].trim();
      if (!billingName && !/\d/.test(rest)) billingName = rest;
      else if (!billingAddress) billingAddress = rest;
      const block = captureAddressBlock(i + 1, 'bill');
      if (block.name && !billingName) billingName = block.name;
      if (block.address) {
        billingAddress = [billingAddress, block.address].filter(Boolean).join('\n').trim();
        i = block.nextIndex - 1;
      }
      if (customerName === 'Unknown Customer' && billingName) customerName = billingName;
      continue;
    }
    if (/^(?:bill\s*to|sold\s*to|invoice\s*to)\s*[:\-]?$/i.test(line)) {
      const block = captureAddressBlock(i + 1, 'bill');
      if (block.name && !billingName) billingName = block.name;
      if (block.address) billingAddress = block.address;
      if (customerName === 'Unknown Customer' && billingName) customerName = billingName;
      i = block.nextIndex - 1;
      continue;
    }

    const shipInline = line.match(
      /^(?:ship\s*to|deliver(?:y)?\s*to|deliver\s*to|receiver|jobsite)\s*[:\-]\s*(.+)$/i
    );
    if (shipInline?.[1]?.trim()) {
      const rest = shipInline[1].trim();
      if (!shippingName && !/\d/.test(rest)) shippingName = rest;
      else if (!shippingAddress) shippingAddress = rest;
      const block = captureAddressBlock(i + 1, 'ship');
      if (block.name && !shippingName) shippingName = block.name;
      if (block.address) {
        shippingAddress = [shippingAddress, block.address].filter(Boolean).join('\n').trim();
        i = block.nextIndex - 1;
      }
      if (customerName === 'Unknown Customer' && shippingName) customerName = shippingName;
      continue;
    }
    if (/^(?:ship\s*to|deliver(?:y)?\s*to|deliver\s*to|receiver|jobsite)\s*[:\-]?$/i.test(line)) {
      const block = captureAddressBlock(i + 1, 'ship');
      if (block.name && !shippingName) shippingName = block.name;
      if (block.address) shippingAddress = block.address;
      if (customerName === 'Unknown Customer' && shippingName) customerName = shippingName;
      i = block.nextIndex - 1;
      continue;
    }

    // Only capture explicitly labeled purchase orders — not invoice/order numbers.
    const poMatch = line.match(
      /^(?:po|p\.?o\.?|purchase\s*order)\s*(?:#|number|no\.?)?\s*[:\-#]?\s*(.+)$/i
    );
    if (poMatch?.[1]?.trim()) {
      const value = poMatch[1].trim();
      if (!/^n\/?a$/i.test(value)) poNumber = value;
    }
  }

  return {
    customerName,
    poNumber,
    billingName,
    billingAddress,
    shippingName,
    shippingAddress
  };
}

function isMetaOrJunkLine(line: string): boolean {
  return /^(customer|bill\s*to|ship\s*to|sold\s*to|deliver(?:y)?\s*to|client|company|po|order|invoice|notes?|qty|quantity|plant|size|description|item|total|subtotal|tax|sales\s*tax|date|page|tel|phone|fax|email|www\.|http|freight|shipping|delivery|balance|amount\s*due|due\s*upon)\b/i.test(
    line
  );
}

function isNonPlantDescription(name: string): boolean {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (!cleaned) return true;
  if (NON_PLANT_NAME_RE.test(cleaned)) return true;
  if (
    /\b(?:freight|sales\s*tax|delivery\s*charge|fuel\s*surcharge|handling\s*fee|labor\s*charge)\b/i.test(
      cleaned
    )
  ) {
    return true;
  }
  return false;
}

/** Street / city lines often look like "123 Main St" and must not become plant rows. */
function looksLikeAddressOrNonPlant(plantName: string, quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 9999) return true;
  const name = plantName.trim();
  if (!name) return true;
  if (isNonPlantDescription(name)) return true;
  if (
    /\b(?:st|street|ave|avenue|rd|road|blvd|ln|lane|dr|drive|way|ct|court|hwy|highway|suite|ste|apt|unit|floor|fl|p\.?\s*o\.?\s*box|zip|phone|fax|email)\b/i.test(
      name
    )
  ) {
    return true;
  }
  // "Baton Rouge LA 70801" / trailing state+zip fragments
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(name)) return true;
  if (/^\d{5}(?:-\d{4})?$/.test(name)) return true;
  // Must contain at least one letter (not SKU-only / price leftovers)
  if (!/[a-zA-Z]/.test(name)) return true;
  return false;
}

function buildItem(quantity: number, rest: string): ParsedOrderItem | null {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 9999 || !rest.trim()) return null;

  // Drop pure charge lines before size parsing (e.g. "Freight $150.00")
  const preliminaryName = cleanPlantName(rest);
  if (isNonPlantDescription(preliminaryName) || isNonPlantDescription(rest.trim())) return null;

  const containerSize = standardizeContainerSize(rest);
  const plantName = preliminaryName;
  if (!plantName || plantName.length < 2) return null;
  if (/^[\d#"\s.]+$/.test(plantName)) return null;
  if (looksLikeAddressOrNonPlant(plantName, quantity)) return null;

  // Bare "Other" with no size cue is usually junk (phone fragments, random text).
  // Keep only when the rest clearly had a plant-ish multi-word name and a leading qty.
  if (containerSize === 'Other') {
    const hasSizeCue =
      /#\s*\d|\b(?:gal(?:lon)?|b\s*&\s*b|tray|flat|inch|in\b|["”]|cal)/i.test(rest) ||
      noteSizePattern().test(rest);
    noteSizePattern().lastIndex = 0;
    if (!hasSizeCue && plantName.split(/\s+/).length < 2) return null;
  }

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

  // Prefer qty-first plant columns; skip pure price columns when joining.
  const useful = (p: string) => !priceTokenPattern().test(p) || /[a-zA-Z#]/.test(p.replace(priceTokenPattern(), ''));

  // qty first: 171 | Wintergreen | B&B | 24"
  if (/^\d+$/.test(parts[0])) {
    const quantity = parseInt(parts[0], 10);
    const rest = parts
      .slice(1)
      .filter((p) => {
        priceTokenPattern().lastIndex = 0;
        return useful(p);
      })
      .join(' ');
    return buildItem(quantity, rest);
  }

  // qty last: Wintergreen | B&B | 24" | 171
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    const quantity = parseInt(last, 10);
    const rest = parts
      .slice(0, -1)
      .filter((p) => {
        priceTokenPattern().lastIndex = 0;
        return useful(p);
      })
      .join(' ');
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

  // City, ST, ZIP style rows
  if (
    parts.length >= 2 &&
    /^[A-Z]{2}$/i.test(parts[1] || '') &&
    /^\d{5}(?:-\d{4})?$/.test(parts[2] || parts[parts.length - 1] || '')
  ) {
    return null;
  }

  const isPriceOnly = (p: string) => {
    const stripped = p.replace(priceTokenPattern(), '').trim();
    return !stripped || /^[\d.\s$]+$/.test(stripped);
  };

  if (/^\d+$/.test(parts[0])) {
    const rest = parts
      .slice(1)
      .filter((p) => !isPriceOnly(p))
      .join(' ');
    return buildItem(parseInt(parts[0], 10), rest);
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    const rest = parts
      .slice(0, -1)
      .filter((p) => !isPriceOnly(p))
      .join(' ');
    return buildItem(parseInt(last, 10), rest);
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

  // Need at least two leading-qty plant chunks. Ignore zip-sized numbers.
  const starts: number[] = [];
  const re = /(?:^|\s)(\d{1,4})\s+(?=[A-Za-z(#])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const qty = parseInt(m[1], 10);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) continue;
    const idx = m.index + (m[0].startsWith(' ') || m[0].startsWith('\t') ? 1 : 0);
    // Peek at the upcoming token — skip street-number + street-suffix pairs.
    const peek = cleaned.slice(idx).match(/^\d+\s+([A-Za-z(#][\w'’-]*)/);
    const firstWord = peek?.[1] || '';
    if (
      /^(?:st|street|ave|avenue|rd|road|blvd|ln|lane|dr|drive|way|ct|court|hwy|suite|ste|apt|unit|box|po)$/i.test(
        firstWord
      )
    ) {
      continue;
    }
    // Don't split on prices like "45.00 Boxwood" — require integer qty tokens only (already).
    // Skip if previous char looks like a decimal price boundary.
    if (idx > 0 && cleaned[idx - 1] === '.') continue;
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

/** Sanitize + collapse duplicate plant+size(+notes) rows. */
export function coalesceOrderItems(items: ParsedOrderItem[]): ParsedOrderItem[] {
  const map = new Map<string, ParsedOrderItem>();
  for (const raw of items) {
    const quantity = Number(raw?.quantity) || 0;
    if (quantity <= 0 || quantity > 9999) continue;

    const containerSize = String(raw?.containerSize || 'Other').trim() || 'Other';
    let plantName = cleanPlantName(String(raw?.plantName || ''));
    if (!plantName) continue;
    if (looksLikeAddressOrNonPlant(plantName, quantity)) continue;

    let notes = String(raw?.notes || '').trim();
    notes = notes
      .replace(priceTokenPattern(), ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const key = `${plantName.toLowerCase()}|${containerSize.toLowerCase()}|${notes.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        plantName,
        containerSize,
        quantity,
        ...(notes ? { notes } : {})
      });
      continue;
    }
    // Same line repeated (overlap / OCR) — keep the larger qty, don't double-count.
    existing.quantity = Math.max(existing.quantity, quantity);
  }
  return [...map.values()];
}

function parseLineItem(line: string): ParsedOrderItem | null {
  const cleaned = line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (isMetaOrJunkLine(cleaned)) return null;
  // Pure money / total lines
  if (/^(?:\$?\d[\d,]*\.?\d*\s*)+$/.test(cleaned)) return null;

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
      // Trailing money amounts are not quantities (e.g. "... 225" from $225.00 already stripped)
      if (rest.length < 3) continue;
      // Prefer not treating a lone trailing number after a price-heavy line as qty
      if (/\$/.test(cleaned) && quantity >= 10) continue;
    }

    const item = buildItem(quantity, rest);
    if (item) return item;
  }

  return null;
}

function buildPlainTextChecklist(
  customerName: string,
  poNumber: string,
  items: ParsedOrderItem[]
): string {
  const header = [`CUSTOMER: ${customerName}`, poNumber ? `PO: ${poNumber}` : null, ''].filter(
    Boolean
  );

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

  const { customerName, poNumber, billingName, billingAddress, shippingName, shippingAddress } =
    extractMeta(rawLines);
  const items: ParsedOrderItem[] = [];

  for (const line of candidateLines) {
    const item = parseLineItem(line);
    if (item) items.push(item);
  }

  const coalesced = coalesceOrderItems(items);
  if (coalesced.length === 0) return null;

  return {
    customerName,
    poNumber,
    billingName,
    billingAddress,
    shippingName,
    shippingAddress,
    items: coalesced,
    plainText: buildPlainTextChecklist(customerName, poNumber, coalesced)
  };
}

/**
 * True when local parse is missing lines OR looks noisy (prices in names, many Other sizes).
 * Caller should fall through to AI in that case.
 */
export function localParseLooksIncomplete(
  rawText: string,
  local: ParsedOrderFromText | null
): boolean {
  if (!local || local.items.length === 0) return true;

  // Sanitization should have removed these; if any remain, distrust local.
  const pricedNames = local.items.filter((i) => /\$/.test(i.plantName)).length;
  if (pricedNames > 0) return true;

  const otherHeavy = local.items.filter((i) => i.containerSize === 'Other').length;
  if (otherHeavy >= Math.max(2, Math.ceil(local.items.length * 0.4))) return true;

  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isMetaOrJunkLine(l));

  // Count lines that look like real plant rows (leading qty + name), not bare prices.
  const plantLikeLines = lines.filter((l) => {
    if (!/^\d{1,4}\s+[A-Za-z(#]/.test(l)) return false;
    if (/\b(?:freight|tax|delivery|labor|fee|total|subtotal|balance)\b/i.test(l)) return false;
    return true;
  }).length;

  if (local.items.length === 1 && plantLikeLines >= 3) return true;
  if (plantLikeLines >= local.items.length + 2) return true;
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
