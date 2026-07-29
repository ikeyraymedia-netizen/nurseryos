import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  deleteDoc
} from 'firebase/firestore';
import { db } from '../firebase';
import { Vendor } from '../types';
import { normalizeVendorName } from './vendorMatch';

let activeTenantId: string | null = null;

export function setVendorsTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function vendorsCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'vendors');
}

function vendorDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'vendors', id);
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

export function subscribeToVendors(callback: (vendors: Vendor[]) => void) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }
  const tenantId = activeTenantId;
  const q = query(vendorsCol(tenantId), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const vendors: Vendor[] = [];
      snapshot.forEach((docSnap) => {
        vendors.push({ id: docSnap.id, ...(docSnap.data() as Omit<Vendor, 'id'>) });
      });
      callback(vendors);
    },
    (error) => {
      console.error('Error subscribing to vendors:', error);
      callback([]);
    }
  );
}

export async function addVendor(
  vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const tenantId = requireTenantId();
  const id = `vend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const full: Vendor = { ...vendor, id, createdAt: now, updatedAt: now };
  await setDoc(vendorDoc(tenantId, id), sanitizeForFirestore(full));
  return id;
}

export async function updateVendor(vendor: Vendor): Promise<void> {
  const tenantId = requireTenantId();
  const { id, ...rest } = vendor;
  await setDoc(
    vendorDoc(tenantId, id),
    sanitizeForFirestore({
      ...rest,
      id,
      // Persist empty terms/address as null so cleared fields don't leave old values
      paymentTerms: rest.paymentTerms?.trim() || null,
      billingAddress: rest.billingAddress?.trim() || null,
      updatedAt: new Date().toISOString()
    }),
    { merge: true }
  );
}

export async function deleteVendor(vendorId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(vendorDoc(tenantId, vendorId));
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      const hasContent = row.some((c) => c.trim().length > 0);
      if (hasContent) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  return rows;
}

export function parseCsvVendors(text: string): Array<Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const normalize = (v: string) => v.trim().toLowerCase();
  const findIdx = (headers: string[], aliases: string[]) =>
    headers.findIndex((h) => aliases.some((alias) => h.includes(alias)));

  const headerRowIdx = rows.findIndex((row) => {
    const headers = row.map(normalize);
    return findIdx(headers, ['name', 'vendor', 'company', 'supplier', 'grower', 'nursery']) >= 0;
  });

  const dataStartIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;
  const headers = (headerRowIdx >= 0 ? rows[headerRowIdx] : rows[0]).map(normalize);

  const nameIdx = findIdx(headers, ['name', 'vendor', 'company', 'supplier', 'grower', 'nursery']);
  const contactIdx = headers.findIndex(
    (h) =>
      (h.includes('contact name') ||
        h.includes('contact person') ||
        h === 'contact' ||
        h === 'rep') &&
      !h.includes('email') &&
      !h.includes('phone') &&
      !h.includes('mail')
  );
  const emailIdx = findIdx(headers, ['email', 'e-mail', 'mail']);
  const phoneIdx = findIdx(headers, ['phone', 'mobile', 'cell', 'telephone']);
  const addressIdx = findIdx(headers, [
    'billing address',
    'bill to address',
    'address',
    'street',
    'location'
  ]);
  const termsIdx = findIdx(headers, ['payment terms', 'terms', 'pay terms']);
  const notesIdx = findIdx(headers, ['note', 'comment', 'memo']);

  const resolvedNameIdx = nameIdx >= 0 ? nameIdx : 0;

  return rows
    .slice(dataStartIdx)
    .map((cols) => {
      const name = (cols[resolvedNameIdx] || '').trim();
      const contactName = contactIdx >= 0 ? (cols[contactIdx] || '').trim() : '';
      const contactEmail = emailIdx >= 0 ? (cols[emailIdx] || '').trim() : '';
      const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').trim() : '';
      const billingAddress = addressIdx >= 0 ? (cols[addressIdx] || '').trim() : '';
      const paymentTerms = termsIdx >= 0 ? (cols[termsIdx] || '').trim() : '';
      const notes = notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '';

      return {
        name,
        contactName: contactName || undefined,
        contactEmail: contactEmail || undefined,
        phone: phone || undefined,
        billingAddress: billingAddress || undefined,
        paymentTerms: paymentTerms || undefined,
        notes: notes || undefined
      };
    })
    .filter((row) => {
      if (!row.name) return false;
      const lower = row.name.toLowerCase();
      if (lower === 'name' || lower === 'vendor' || lower === 'vendor name') return false;
      return true;
    });
}

export async function bulkImportVendors(
  vendors: Array<Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<number> {
  const tenantId = requireTenantId();
  const existingSnap = await getDocs(vendorsCol(tenantId));
  const existingNames = new Set(
    existingSnap.docs.map((snap) =>
      normalizeVendorName(String((snap.data() as { name?: string }).name || ''))
    )
  );

  let count = 0;
  for (const vendor of vendors) {
    const key = normalizeVendorName(vendor.name || '');
    if (!key || existingNames.has(key)) continue;
    await addVendor(vendor);
    existingNames.add(key);
    count += 1;
  }
  return count;
}
