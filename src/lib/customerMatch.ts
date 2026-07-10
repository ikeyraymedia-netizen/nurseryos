import { Customer } from '../types';

export function normalizeCustomerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/\b(inc|llc|ltd|co|company|corp|corporation)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function customerWordSet(name: string): Set<string> {
  return new Set(
    normalizeCustomerName(name)
      .split(' ')
      .filter((w) => w.length >= 2)
  );
}

export function customerNamesMatch(a: string, b: string): boolean {
  const na = normalizeCustomerName(a);
  const nb = normalizeCustomerName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;

  const setA = customerWordSet(a);
  const setB = customerWordSet(b);
  if (setA.size === 0 || setB.size === 0) return false;

  let overlap = 0;
  setA.forEach((w) => {
    if (setB.has(w)) overlap += 1;
  });
  const minSize = Math.min(setA.size, setB.size);
  return overlap >= minSize && overlap >= 1;
}

export type CustomerMatchConfidence = 'exact' | 'fuzzy' | 'none';

export interface CustomerMatchResult {
  best: Customer | null;
  suggestions: Customer[];
  confidence: CustomerMatchConfidence;
}

export function findMatchingCustomers(parsedName: string, customers: Customer[]): CustomerMatchResult {
  const trimmed = parsedName.trim();
  if (!trimmed || customers.length === 0) {
    return { best: null, suggestions: [], confidence: 'none' };
  }

  const normalizedParsed = normalizeCustomerName(trimmed);
  const scored = customers
    .map((customer) => {
      const normalizedCustomer = normalizeCustomerName(customer.name);
      let score = 0;
      if (normalizedCustomer === normalizedParsed) score = 100;
      else if (customerNamesMatch(trimmed, customer.name)) score = 70;
      else {
        const setP = customerWordSet(trimmed);
        const setC = customerWordSet(customer.name);
        let overlap = 0;
        setP.forEach((w) => {
          if (setC.has(w)) overlap += 1;
        });
        if (overlap > 0) score = 30 + overlap * 10;
      }
      return { customer, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { best: null, suggestions: [], confidence: 'none' };
  }

  const best = scored[0].customer;
  const confidence: CustomerMatchConfidence =
    scored[0].score >= 100 ? 'exact' : scored[0].score >= 70 ? 'fuzzy' : 'none';

  return {
    best: confidence === 'none' ? null : best,
    suggestions: scored.slice(0, 5).map((row) => row.customer),
    confidence
  };
}
