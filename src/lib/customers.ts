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

function ordersCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'orders');
}

function documentsCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'documents');
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

function normalizeCustomerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function customerCompletenessScore(customer: Customer): number {
  let score = 0;
  if (customer.contactEmail) score += 3;
  if (customer.phone) score += 2;
  if (customer.billingName) score += 1;
  if (customer.billingAddress) score += 2;
  if (customer.shippingName) score += 1;
  if (customer.shippingAddress || customer.receiverAddress) score += 2;
  if (customer.pointOfContact) score += 1;
  if (customer.paymentTerms) score += 1;
  if (customer.notes) score += 1;
  return score;
}

function pickKeeper(group: Customer[]): Customer {
  return [...group].sort((a, b) => {
    const scoreDiff = customerCompletenessScore(b) - customerCompletenessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  })[0];
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

/** Count how many customer names appear more than once. */
export function countDuplicateCustomerNames(customers: Customer[]): number {
  const counts = new Map<string, number>();
  for (const customer of customers) {
    const key = normalizeCustomerName(customer.name || '');
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let extras = 0;
  for (const count of counts.values()) {
    if (count > 1) extras += count - 1;
  }
  return extras;
}

/**
 * Keep one customer per normalized name (preferring the most complete record),
 * delete extras, and re-point orders/documents that used a removed id.
 */
export async function deduplicateCustomersByName(): Promise<{
  duplicateGroups: number;
  removed: number;
  remappedOrders: number;
  remappedDocuments: number;
}> {
  const tenantId = requireTenantId();
  const snapshot = await getDocs(customersCol(tenantId));
  const customers: Customer[] = snapshot.docs.map((snap) => ({
    id: snap.id,
    ...(snap.data() as Omit<Customer, 'id'>)
  }));

  const groups = new Map<string, Customer[]>();
  for (const customer of customers) {
    const key = normalizeCustomerName(customer.name || '');
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(customer);
    groups.set(key, list);
  }

  const idRemap = new Map<string, string>();
  const toDelete: string[] = [];
  let duplicateGroups = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    const keeper = pickKeeper(group);
    for (const customer of group) {
      if (customer.id === keeper.id) continue;
      idRemap.set(customer.id, keeper.id);
      toDelete.push(customer.id);
    }
  }

  if (toDelete.length === 0) {
    return { duplicateGroups: 0, removed: 0, remappedOrders: 0, remappedDocuments: 0 };
  }

  let remappedOrders = 0;
  const ordersSnap = await getDocs(ordersCol(tenantId));
  for (const orderSnap of ordersSnap.docs) {
    const data = orderSnap.data() as { customerId?: string; customerName?: string };
    const nextId = data.customerId ? idRemap.get(data.customerId) : undefined;
    if (!nextId) continue;
    await updateDoc(orderSnap.ref, {
      customerId: nextId,
      updatedAt: new Date().toISOString()
    });
    remappedOrders += 1;
  }

  let remappedDocuments = 0;
  const docsSnap = await getDocs(documentsCol(tenantId));
  for (const docSnap of docsSnap.docs) {
    const data = docSnap.data() as { customerId?: string };
    const nextId = data.customerId ? idRemap.get(data.customerId) : undefined;
    if (!nextId) continue;
    await updateDoc(docSnap.ref, {
      customerId: nextId,
      updatedAt: new Date().toISOString()
    });
    remappedDocuments += 1;
  }

  let removed = 0;
  let batch = writeBatch(db);
  let ops = 0;
  for (const id of toDelete) {
    batch.delete(customerDoc(tenantId, id));
    ops += 1;
    removed += 1;
    if (ops >= 450) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { duplicateGroups, removed, remappedOrders, remappedDocuments };
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
  const billIdx = findIdx(headers, ['bill to address', 'billing address', 'bill address', 'billto', 'bill']);
  const shipIdx = findIdx(headers, ['ship to address', 'shipping address', 'ship address', 'shipto', 'ship']);
  const billNameIdx = findIdx(headers, ['bill to name', 'billing name', 'bill name']);
  const shipNameIdx = findIdx(headers, ['ship to name', 'shipping name', 'ship name']);

  const resolvedNameIdx = nameIdx >= 0 ? nameIdx : 0;

  return rows
    .slice(dataStartIdx)
    .map((cols) => {
      const name = (cols[resolvedNameIdx] || '').trim();
      const email = emailIdx >= 0 ? (cols[emailIdx] || '').trim() : '';
      const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').trim() : '';
      const notes = notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '';
      const billingAddress = billIdx >= 0 ? (cols[billIdx] || '').trim() : '';
      const shippingAddress = shipIdx >= 0 ? (cols[shipIdx] || '').trim() : '';
      const billingName = billNameIdx >= 0 ? (cols[billNameIdx] || '').trim() : '';
      const shippingName = shipNameIdx >= 0 ? (cols[shipNameIdx] || '').trim() : '';

      return {
        name,
        contactEmail: email || undefined,
        phone: phone || undefined,
        billingName: billingName || undefined,
        billingAddress: billingAddress || undefined,
        shippingName: shippingName || undefined,
        shippingAddress: shippingAddress || undefined,
        receiverAddress: shippingAddress || undefined,
        notes: notes || undefined
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
  const tenantId = requireTenantId();
  const existingSnap = await getDocs(customersCol(tenantId));
  const existingNames = new Set(
    existingSnap.docs.map((snap) =>
      normalizeCustomerName(String((snap.data() as { name?: string }).name || ''))
    )
  );

  let count = 0;
  for (const customer of customers) {
    const key = normalizeCustomerName(customer.name || '');
    if (!key || existingNames.has(key)) continue;
    await addCustomer(customer);
    existingNames.add(key);
    count += 1;
  }
  return count;
}
