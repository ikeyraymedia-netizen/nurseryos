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

export function vendorNamesMatch(a: string, b: string): boolean {
  const na = normalizeVendorName(a);
  const nb = normalizeVendorName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

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
      if (normalizedVendor === normalizedParsed) score = 100;
      else if (vendorNamesMatch(trimmed, vendor.name)) score = 70;
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
