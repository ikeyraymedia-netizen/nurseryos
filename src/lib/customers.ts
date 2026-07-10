import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { Customer } from '../types';

let activeTenantId: string | null = null;

export function setCustomersTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function customersCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'customers');
}

function customerDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'customers', id);
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

export function subscribeToCustomers(callback: (customers: Customer[]) => void) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }

  const tenantId = activeTenantId;
  const q = query(customersCol(tenantId), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const customers: Customer[] = [];
      snapshot.forEach((docSnap) => {
        customers.push({ id: docSnap.id, ...(docSnap.data() as Omit<Customer, 'id'>) });
      });
      callback(customers);
    },
    (error) => {
      console.error('Error subscribing to customers:', error);
      callback([]);
    }
  );
}

export async function addCustomer(customer: Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  const tenantId = requireTenantId();
  const id = `cust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const full: Customer = {
    ...customer,
    id,
    createdAt: now,
    updatedAt: now
  };
  await setDoc(customerDoc(tenantId, id), sanitizeForFirestore(full));
  return id;
}

export async function updateCustomer(customer: Customer): Promise<void> {
  const tenantId = requireTenantId();
  const { id, ...rest } = customer;
  await updateDoc(
    customerDoc(tenantId, id),
    sanitizeForFirestore({
      ...rest,
      updatedAt: new Date().toISOString()
    })
  );
}

export async function deleteAllCustomers(): Promise<number> {
  const tenantId = requireTenantId();
  const snapshot = await getDocs(customersCol(tenantId));
  if (snapshot.empty) return 0;

  let deleted = 0;
  let batch = writeBatch(db);
  let ops = 0;

  for (const docSnap of snapshot.docs) {
    batch.delete(docSnap.ref);
    ops += 1;
    deleted += 1;
    if (ops >= 500) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();
  return deleted;
}

export function parseCsvCustomers(text: string): Array<Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const normalize = (v: string) => v.trim().toLowerCase();
  const findIdx = (headers: string[], aliases: string[]) =>
    headers.findIndex((h) => aliases.some((alias) => h.includes(alias)));

  const headerRowIdx = rows.findIndex((row) => {
    const headers = row.map(normalize);
    const hasName = findIdx(headers, ['name', 'customer', 'client', 'company', 'business']) >= 0;
    const hasAnyContact = findIdx(headers, ['email', 'phone', 'mobile', 'cell']) >= 0;
    return hasName && hasAnyContact;
  });

  const dataStartIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;
  const headers = (headerRowIdx >= 0 ? rows[headerRowIdx] : rows[0]).map(normalize);

  const nameIdx = findIdx(headers, ['name', 'customer', 'client', 'company', 'business']);
  const emailIdx = findIdx(headers, ['email', 'e-mail', 'mail']);
  const phoneIdx = findIdx(headers, ['phone', 'mobile', 'cell', 'telephone']);
  const notesIdx = findIdx(headers, ['note', 'comment', 'memo']);
  const billIdx = findIdx(headers, ['bill']);
  const shipIdx = findIdx(headers, ['ship']);

  const resolvedNameIdx = nameIdx >= 0 ? nameIdx : 0;

  return rows
    .slice(dataStartIdx)
    .map((cols) => {
      const name = (cols[resolvedNameIdx] || '').trim();
      const email = emailIdx >= 0 ? (cols[emailIdx] || '').trim() : '';
      const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').trim() : '';
      const notesParts = [
        notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '',
        billIdx >= 0 ? `Bill: ${(cols[billIdx] || '').trim()}` : '',
        shipIdx >= 0 ? `Ship: ${(cols[shipIdx] || '').trim()}` : ''
      ].filter((v) => v && !v.endsWith('Bill:') && !v.endsWith('Ship:'));

      return {
        name,
        contactEmail: email || undefined,
        phone: phone || undefined,
        notes: notesParts.join(' | ') || undefined
      };
    })
    .filter((row) => {
      if (!row.name) return false;
      const lower = row.name.toLowerCase();
      if (lower.includes('customer contact list')) return false;
      if (lower.startsWith('wednesday,')) return false;
      return true;
    });
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

export async function bulkImportCustomers(
  customers: Array<Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<number> {
  let count = 0;
  for (const customer of customers) {
    await addCustomer(customer);
    count += 1;
  }
  return count;
}
