import { Vendor } from '../types';

export function normalizeVendorName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/\b(inc|llc|ltd|co|company|corp|corporation|nursery|nurseries|farms?|growers?)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function vendorWordSet(name: string): Set<string> {
  return new Set(
    normalizeVendorName(name)
      .split(' ')
      .filter((w) => w.length >= 2)
  );
}

/** Letters and numbers only, so "Jackrabbit" and "Jack Rabbit" compare the same. */
export function compactVendorKey(name: string): string {
  return normalizeVendorName(name).replace(/[^a-z0-9]/g, '');
}

export function vendorNamesMatch(a: string, b: string): boolean {
  const na = normalizeVendorName(a);
  const nb = normalizeVendorName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ca = compactVendorKey(a);
  const cb = compactVendorKey(b);
  if (ca.length >= 6 && ca === cb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  const setA = vendorWordSet(a);
  const setB = vendorWordSet(b);
  if (setA.size === 0 || setB.size === 0) return false;

  let overlap = 0;
  setA.forEach((w) => {
    if (setB.has(w)) overlap += 1;
  });
  const minSize = Math.min(setA.size, setB.size);
  return overlap >= minSize && overlap >= 1;
}

export type VendorMatchConfidence = 'exact' | 'fuzzy' | 'none';

export interface VendorMatchResult {
  best: Vendor | null;
  suggestions: Vendor[];
  confidence: VendorMatchConfidence;
}

export function findMatchingVendors(parsedName: string, vendors: Vendor[]): VendorMatchResult {
  const trimmed = parsedName.trim();
  if (!trimmed || vendors.length === 0) {
    return { best: null, suggestions: [], confidence: 'none' };
  }

  const normalizedParsed = normalizeVendorName(trimmed);
  const scored = vendors
    .map((vendor) => {
      const normalizedVendor = normalizeVendorName(vendor.name);
      let score = 0;
      if (
        normalizedVendor === normalizedParsed ||
        (compactVendorKey(vendor.name).length >= 6 &&
          compactVendorKey(vendor.name) === compactVendorKey(trimmed))
      ) {
        score = 100;
      } else if (vendorNamesMatch(trimmed, vendor.name)) score = 70;
      else {
        const setP = vendorWordSet(trimmed);
        const setV = vendorWordSet(vendor.name);
        let overlap = 0;
        setP.forEach((w) => {
          if (setV.has(w)) overlap += 1;
        });
        if (overlap > 0) score = 30 + overlap * 10;
      }
      return { vendor, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { best: null, suggestions: [], confidence: 'none' };
  }

  const best = scored[0].vendor;
  const confidence: VendorMatchConfidence =
    scored[0].score >= 100 ? 'exact' : scored[0].score >= 70 ? 'fuzzy' : 'none';

  return {
    best: confidence === 'none' ? null : best,
    suggestions: scored.slice(0, 5).map((s) => s.vendor),
    confidence
  };
}

function documentHostStems(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:https?:\/\/|www\.)?(?:www\.)?([a-z0-9-]+)\.(?:com|net|org|us)\b/gi
  )) {
    hosts.add(match[1].toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  return [...hosts];
}

/**
 * Jack Rabbit invoices put the seller in the logo and on jackrabbitnursery.com.
 * Bill To / Ship To is the nursery buying the plants, so the printed customer
 * name must not become a new vendor.
 */
export function inferVendorFromDocument(
  documentText: string,
  vendorNames: string[],
  buyerName = ''
): string | null {
  const text = documentText || '';
  if (!text.trim() || vendorNames.length === 0) return null;
  const hosts = documentHostStems(text);
  const compactText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best: { name: string; score: number } | null = null;

  for (const name of vendorNames) {
    if (buyerName && vendorNamesMatch(name, buyerName)) continue;
    const key = compactVendorKey(name);
    if (key.length < 8) continue;
    let score = 0;
    for (const host of hosts) {
      if (host.startsWith(key) || (host.length >= 8 && key.startsWith(host))) {
        score = Math.max(score, 100 + key.length);
      }
    }
    if (compactText.includes(key)) score = Math.max(score, 50 + key.length);
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }

  return best?.name ?? null;
}

export function resolveInvoiceVendorName(
  parsedName: string,
  documentText: string,
  vendorNames: string[],
  buyerName = ''
): string {
  const parsed = parsedName.trim();
  const parsedIsBuyer = Boolean(buyerName) && vendorNamesMatch(parsed, buyerName);
  if (parsed && !parsedIsBuyer) {
    const direct = vendorNames.find((name) => vendorNamesMatch(parsed, name));
    if (direct) return direct;
  }
  const inferred = inferVendorFromDocument(documentText, vendorNames, buyerName);
  if (inferred) return inferred;
  if (parsedIsBuyer) return '';
  return parsed;
}
