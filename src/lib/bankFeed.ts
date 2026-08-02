import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  limit
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  BankFeedAccountKind,
  BankFeedTransaction,
  Vendor,
  VendorBill
} from '../types';
import { findMatchingVendors, normalizeVendorName } from './vendorMatch';
import { normalizePurchaseCategory } from './purchaseCategories';
import { createVendorBill, markVendorBillPaid } from './purchasing';
import { updateVendor } from './vendors';

let activeTenantId: string | null = null;

export function setBankFeedTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
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

function feedCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'bankFeedTransactions');
}

function feedDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'bankFeedTransactions', id);
}

export function cleanMerchantDescription(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^(pos|purchase|debit|credit|checkcard|chkcard|visa|mastercard|mc|ach|web)\s+/i, '');
  s = s.replace(/\s+#?\d{4,}.*$/i, '');
  s = s.replace(/\s+\d{2}\/\d{2}.*$/i, '');
  s = s.replace(/\*+[A-Z0-9]+/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 120);
}

export function bankFeedFingerprint(date: string, amount: number, description: string): string {
  const amt = Math.round(amount * 100);
  const desc = normalizeVendorName(description).slice(0, 80);
  return `${date}|${amt}|${desc}`;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function headerIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    const idx = normalized.findIndex((h) => h === c || h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseAmountCell(raw: string): number | null {
  let s = String(raw || '').trim();
  if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return null;
  const parenNeg = /^\(.*\)$/.test(s);
  s = s.replace(/[($)\s]/g, '').replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return parenNeg ? -Math.abs(n) : n;
}

function parseDateCell(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, '0');
    const dd = mdy[2].padStart(2, '0');
    let yyyy = mdy[3];
    if (yyyy.length === 2) yyyy = Number(yyyy) > 70 ? `19${yyyy}` : `20${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

export interface ParsedBankCsvRow {
  date: string;
  description: string;
  merchant: string;
  amount: number;
  fingerprint: string;
}

export function parseBankFeedCsv(
  text: string,
  accountKind: BankFeedAccountKind
): { rows: ParsedBankCsvRow[]; skipped: number } {
  const table = parseCsvRows(text);
  if (table.length < 2) return { rows: [], skipped: 0 };

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(table.length, 8); i++) {
    const h = table[i].map((c) => c.toLowerCase());
    const hasDate = h.some((c) => /date|posted|trans/.test(c));
    const hasAmt = h.some((c) => /amount|debit|credit|withdraw|deposit/.test(c));
    if (hasDate && hasAmt) {
      headerRowIdx = i;
      break;
    }
  }

  const headers = table[headerRowIdx];
  const dateIdx = headerIndex(headers, [
    'posting date',
    'post date',
    'trans date',
    'transaction date',
    'date'
  ]);
  const descIdx = headerIndex(headers, [
    'description',
    'payee',
    'merchant',
    'name',
    'memo',
    'details'
  ]);
  const amountIdx = headerIndex(headers, ['amount', 'transaction amount']);
  const debitIdx = headerIndex(headers, ['debit', 'withdrawal', 'withdrawals']);
  const creditIdx = headerIndex(headers, ['credit', 'deposit', 'deposits']);

  if (dateIdx < 0 || (amountIdx < 0 && debitIdx < 0 && creditIdx < 0)) {
    throw new Error(
      'Could not find Date and Amount columns. Export a CSV with Date, Description, and Amount.'
    );
  }
  if (descIdx < 0) {
    throw new Error('Could not find a Description / Payee column in this CSV.');
  }

  const rows: ParsedBankCsvRow[] = [];
  let skipped = 0;

  for (let i = headerRowIdx + 1; i < table.length; i++) {
    const cols = table[i];
    const date = parseDateCell(cols[dateIdx] || '');
    const description = String(cols[descIdx] || '').trim();
    if (!date || !description) {
      skipped += 1;
      continue;
    }

    let signed: number | null = null;
    if (amountIdx >= 0) {
      signed = parseAmountCell(cols[amountIdx] || '');
    } else {
      const debit = debitIdx >= 0 ? parseAmountCell(cols[debitIdx] || '') : null;
      const credit = creditIdx >= 0 ? parseAmountCell(cols[creditIdx] || '') : null;
      if (debit != null && debit !== 0) signed = -Math.abs(debit);
      else if (credit != null && credit !== 0) signed = Math.abs(credit);
    }

    if (signed == null || signed === 0) {
      skipped += 1;
      continue;
    }

    if (accountKind === 'card') {
      if (signed > 0) signed = -signed;
      else signed = Math.abs(signed);
    }

    const merchant = cleanMerchantDescription(description);
    const fingerprint = bankFeedFingerprint(date, signed, description);
    rows.push({ date, description, merchant, amount: signed, fingerprint });
  }

  return { rows, skipped };
}

export function suggestVendorForFeedRow(
  description: string,
  merchant: string,
  vendors: Vendor[]
) {
  const texts = [merchant, description].filter(Boolean);
  let best = findMatchingVendors(texts[0] || '', vendors);
  for (const text of texts.slice(1)) {
    const next = findMatchingVendors(text, vendors);
    const rank = (c: string) => (c === 'exact' ? 2 : c === 'fuzzy' ? 1 : 0);
    if (rank(next.confidence) > rank(best.confidence)) best = next;
  }
  const needle = normalizeVendorName(merchant || description);
  if (needle) {
    for (const vendor of vendors) {
      for (const alias of vendor.merchantAliases || []) {
        const na = normalizeVendorName(alias);
        if (!na) continue;
        if (na === needle || needle.includes(na) || na.includes(needle)) {
          return {
            best: vendor,
            suggestions: [vendor, ...best.suggestions.filter((v) => v.id !== vendor.id)].slice(
              0,
              5
            ),
            confidence: 'exact' as const
          };
        }
      }
    }
  }
  return best;
}

export function subscribeToBankFeedTransactions(
  callback: (rows: BankFeedTransaction[]) => void
) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }
  const tenantId = activeTenantId;
  const q = query(feedCol(tenantId), orderBy('date', 'desc'), limit(500));
  return onSnapshot(
    q,
    (snapshot) => {
      const rows: BankFeedTransaction[] = [];
      snapshot.forEach((docSnap) => {
        rows.push({ id: docSnap.id, ...(docSnap.data() as Omit<BankFeedTransaction, 'id'>) });
      });
      callback(rows);
    },
    (error) => {
      console.error('Error subscribing to bank feed:', error);
      callback([]);
    }
  );
}

export async function importBankFeedCsv(params: {
  text: string;
  accountKind: BankFeedAccountKind;
  accountLabel?: string;
  vendors: Vendor[];
}): Promise<{ imported: number; duplicates: number; skipped: number; batchId: string }> {
  const tenantId = requireTenantId();
  const { rows, skipped } = parseBankFeedCsv(params.text, params.accountKind);
  if (rows.length === 0) {
    return { imported: 0, duplicates: 0, skipped, batchId: '' };
  }

  const existing = await getDocs(feedCol(tenantId));
  const existingFp = new Set<string>();
  existing.forEach((docSnap) => {
    const fp = String((docSnap.data() as BankFeedTransaction).fingerprint || '');
    if (fp) existingFp.add(fp);
  });

  const batchId = `bf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  let imported = 0;
  let duplicates = 0;

  for (const row of rows) {
    if (existingFp.has(row.fingerprint)) {
      duplicates += 1;
      continue;
    }
    existingFp.add(row.fingerprint);
    const match = suggestVendorForFeedRow(row.description, row.merchant, params.vendors);
    const id = `bftx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: BankFeedTransaction = {
      id,
      date: row.date,
      description: row.description,
      merchant: row.merchant || undefined,
      amount: row.amount,
      accountKind: params.accountKind,
      accountLabel: params.accountLabel?.trim() || undefined,
      source: 'csv',
      importBatchId: batchId,
      fingerprint: row.fingerprint,
      status: 'unreviewed',
      vendorId: match.best?.id || null,
      vendorName: match.best?.name || null,
      category: null,
      matchConfidence: match.confidence === 'none' ? 'none' : match.confidence,
      createdAt: now,
      updatedAt: now
    };
    await setDoc(feedDoc(tenantId, id), sanitizeForFirestore(full));
    imported += 1;
  }

  return { imported, duplicates, skipped, batchId };
}

export async function updateBankFeedTransaction(tx: BankFeedTransaction): Promise<void> {
  const tenantId = requireTenantId();
  const { id, ...rest } = tx;
  await setDoc(
    feedDoc(tenantId, id),
    sanitizeForFirestore({ ...rest, id, updatedAt: new Date().toISOString() }),
    { merge: true }
  );
}

export async function ignoreBankFeedTransaction(tx: BankFeedTransaction): Promise<void> {
  await updateBankFeedTransaction({ ...tx, status: 'ignored' });
}

async function learnVendorAlias(vendor: Vendor, merchant: string): Promise<void> {
  const cleaned = cleanMerchantDescription(merchant);
  if (!cleaned || cleaned.length < 3) return;
  const aliases = [...(vendor.merchantAliases || [])];
  const key = normalizeVendorName(cleaned);
  if (!key) return;
  if (aliases.some((a) => normalizeVendorName(a) === key)) return;
  if (normalizeVendorName(vendor.name) === key) return;
  aliases.unshift(cleaned);
  await updateVendor({
    ...vendor,
    merchantAliases: aliases.slice(0, 25)
  });
}

export async function confirmBankFeedExpense(params: {
  tx: BankFeedTransaction;
  vendor: Vendor;
  category: string;
}): Promise<string> {
  const amount = Math.abs(params.tx.amount);
  if (!(amount > 0) || params.tx.amount >= 0) {
    throw new Error('Only money-out transactions can be tagged as expenses.');
  }
  const category = normalizePurchaseCategory(params.category || 'Other');
  const billId = await createVendorBill({
    vendorId: params.vendor.id,
    vendorName: params.vendor.name,
    billDate: params.tx.date,
    notes: `Imported from ${params.tx.accountKind === 'card' ? 'card' : 'bank'} CSV: ${params.tx.description}`,
    items: [
      {
        plantName: params.tx.merchant || params.tx.description.slice(0, 80),
        containerSize: '',
        quantity: 1,
        unitCost: amount,
        category
      }
    ],
    status: 'unpaid'
  });

  const now = new Date().toISOString();
  const paymentMethod = params.tx.accountKind === 'card' ? 'cc' : 'ach';
  const tenantId = requireTenantId();
  await updateDoc(doc(db, 'tenants', tenantId, 'vendorBills', billId), {
    status: 'paid',
    paidAt: now,
    paymentMethod,
    paymentReference: params.tx.description.slice(0, 80),
    updatedAt: now
  });

  await learnVendorAlias(params.vendor, params.tx.merchant || params.tx.description);

  await updateBankFeedTransaction({
    ...params.tx,
    status: 'tagged',
    vendorId: params.vendor.id,
    vendorName: params.vendor.name,
    category,
    vendorBillId: billId,
    matchConfidence: 'manual'
  });

  return billId;
}

export function findBillMatchesForFeed(
  tx: BankFeedTransaction,
  bills: VendorBill[]
): VendorBill[] {
  if (!tx.vendorId || tx.amount >= 0) return [];
  const target = Math.abs(tx.amount);
  return bills
    .filter((b) => {
      if (b.status === 'paid') return false;
      if (b.vendorId !== tx.vendorId) return false;
      const diff = Math.abs((b.grandTotal || 0) - target);
      return diff < 0.02 || diff / Math.max(target, 1) < 0.02;
    })
    .slice(0, 5);
}

export async function matchBankFeedToBill(params: {
  tx: BankFeedTransaction;
  bill: VendorBill;
  vendor: Vendor;
}): Promise<void> {
  const paymentMethod = params.tx.accountKind === 'card' ? 'cc' : 'ach';
  await markVendorBillPaid(params.bill, {
    method: paymentMethod,
    reference: params.tx.description.slice(0, 80)
  });
  await learnVendorAlias(params.vendor, params.tx.merchant || params.tx.description);
  await updateBankFeedTransaction({
    ...params.tx,
    status: 'tagged',
    vendorId: params.vendor.id,
    vendorName: params.vendor.name,
    vendorBillId: params.bill.id,
    category: params.tx.category || params.bill.items?.[0]?.category || 'Other',
    matchConfidence: 'manual'
  });
}
