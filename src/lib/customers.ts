import {
  collection,
  doc,
  deleteDoc,
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
import { parseCcEmails } from './email';

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

/**
 * QuickBooks / contact-list exports often put both addresses in one cell:
 * "Bill: 123 Main St City ST 00000 | Ship: 456 Oak Ave City ST 00000"
 */
export function splitCombinedBillShipAddress(
  raw: string
): { billingAddress: string; shippingAddress: string } | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  const labeled =
    /^\s*bill(?:ing)?(?:\s*[-–]?\s*to)?\s*:\s*(.+?)\s*(?:\||\s{2,}|\s+-\s+)\s*ship(?:ping)?(?:\s*[-–]?\s*to)?\s*:\s*(.+)\s*$/i.exec(
      text
    ) ||
    /^\s*bill(?:ing)?(?:\s*[-–]?\s*to)?\s*:\s*(.+?)\s+ship(?:ping)?(?:\s*[-–]?\s*to)?\s*:\s*(.+)\s*$/i.exec(
      text
    );

  if (!labeled) return null;

  const billingAddress = labeled[1].trim().replace(/\s+/g, ' ');
  const shippingAddress = labeled[2].trim().replace(/\s+/g, ' ');
  if (!billingAddress && !shippingAddress) return null;
  return {
    billingAddress: billingAddress || shippingAddress,
    shippingAddress: shippingAddress || billingAddress
  };
}

function resolveImportedAddresses(input: {
  billCell?: string;
  shipCell?: string;
  addressCell?: string;
}): { billingAddress?: string; shippingAddress?: string } {
  const billCell = (input.billCell || '').trim();
  const shipCell = (input.shipCell || '').trim();
  const addressCell = (input.addressCell || '').trim();

  const fromBill = splitCombinedBillShipAddress(billCell);
  const fromShip = splitCombinedBillShipAddress(shipCell);
  const fromAddress = splitCombinedBillShipAddress(addressCell);

  let billingAddress =
    fromBill?.billingAddress ||
    fromShip?.billingAddress ||
    fromAddress?.billingAddress ||
    '';
  let shippingAddress =
    fromBill?.shippingAddress ||
    fromShip?.shippingAddress ||
    fromAddress?.shippingAddress ||
    '';

  if (!fromBill && billCell) billingAddress = billingAddress || billCell;
  if (!fromShip && shipCell) shippingAddress = shippingAddress || shipCell;

  if (!fromAddress && addressCell) {
    if (!billingAddress) billingAddress = addressCell;
    if (!shippingAddress) shippingAddress = addressCell;
  }

  // Same plain value in both bill + ship columns
  if (!shippingAddress && billingAddress && !fromBill && !fromShip && !fromAddress) {
    shippingAddress = billingAddress;
  }
  if (!billingAddress && shippingAddress && !fromBill && !fromShip && !fromAddress) {
    billingAddress = shippingAddress;
  }

  return {
    billingAddress: billingAddress || undefined,
    shippingAddress: shippingAddress || undefined
  };
}

/** Split Bill:|Ship: blobs already stored on customer address fields. */
export function withSplitCustomerAddresses<T extends Partial<Customer>>(customer: T): T {
  const candidates = [
    customer.billingAddress,
    customer.shippingAddress,
    customer.receiverAddress
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const split = splitCombinedBillShipAddress(raw);
    if (!split) continue;
    return {
      ...customer,
      billingAddress: split.billingAddress,
      shippingAddress: split.shippingAddress,
      receiverAddress: split.shippingAddress
    };
  }
  return customer;
}

export async function repairCombinedCustomerAddresses(): Promise<number> {
  const tenantId = requireTenantId();
  const snap = await getDocs(customersCol(tenantId));
  let repaired = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Customer;
    const beforeBill = data.billingAddress || '';
    const beforeShip = data.shippingAddress || data.receiverAddress || '';
    const next = withSplitCustomerAddresses({ ...data, id: docSnap.id });
    if (
      (next.billingAddress || '') === beforeBill &&
      (next.shippingAddress || next.receiverAddress || '') === beforeShip
    ) {
      continue;
    }
    await updateCustomer(next as Customer);
    repaired += 1;
  }

  return repaired;
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

function mergeEmailCc(a?: string, b?: string, primaryEmail?: string): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [a, b]) {
    const { cc } = parseCcEmails(raw, primaryEmail);
    for (const email of cc) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out.length ? out.join(', ') : undefined;
}

function mergeScalarField(
  keeper: Customer,
  other: Customer,
  field: keyof Customer,
  label: string,
  conflicts: string[]
): string | undefined {
  const a = String(keeper[field] || '').trim();
  const b = String(other[field] || '').trim();
  if (a && b && a !== b) {
    conflicts.push(`${label}: kept "${a}" (also had "${b}" on ${other.name})`);
  }
  return a || b || undefined;
}

/** Build merged customer profile — keeper id wins; fills blanks from other; conflicts go to notes. */
export function buildMergedCustomer(keeper: Customer, other: Customer): Customer {
  const conflicts: string[] = [];
  const contactEmail = mergeScalarField(keeper, other, 'contactEmail', 'Email', conflicts);
  const phone = mergeScalarField(keeper, other, 'phone', 'Phone', conflicts);
  const billingName = mergeScalarField(keeper, other, 'billingName', 'Bill-to name', conflicts);
  const billingAddress = mergeScalarField(keeper, other, 'billingAddress', 'Bill-to address', conflicts);
  const shippingName = mergeScalarField(keeper, other, 'shippingName', 'Ship-to name', conflicts);
  const shippingAddress =
    mergeScalarField(keeper, other, 'shippingAddress', 'Ship-to address', conflicts) ||
    mergeScalarField(keeper, other, 'receiverAddress', 'Ship-to address', conflicts);
  const pointOfContact = mergeScalarField(keeper, other, 'pointOfContact', 'Contact', conflicts);
  const paymentTerms = mergeScalarField(keeper, other, 'paymentTerms', 'Payment terms', conflicts);

  const noteParts: string[] = [];
  if (keeper.notes?.trim()) noteParts.push(keeper.notes.trim());
  if (other.notes?.trim() && other.notes.trim() !== keeper.notes?.trim()) {
    noteParts.push(`[${other.name}] ${other.notes.trim()}`);
  }
  if (conflicts.length) {
    noteParts.push(`Merged from ${other.name}:\n${conflicts.map((c) => `• ${c}`).join('\n')}`);
  }

  return {
    ...keeper,
    name: keeper.name.trim() || other.name.trim(),
    contactEmail,
    contactEmailCc: mergeEmailCc(keeper.contactEmailCc, other.contactEmailCc, contactEmail),
    phone,
    billingName,
    billingAddress,
    shippingName,
    shippingAddress,
    receiverAddress: undefined,
    pointOfContact,
    paymentTerms,
    notes: noteParts.length ? noteParts.join('\n\n') : undefined,
    createdAt:
      [keeper.createdAt, other.createdAt].filter(Boolean).sort()[0] || keeper.createdAt,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Merge `mergeId` into `keeperId`: combine profiles, re-link orders/documents, delete the extra record.
 */
export async function mergeCustomers(params: {
  keeperId: string;
  mergeId: string;
}): Promise<{
  remappedOrders: number;
  remappedDocuments: number;
  mergedCustomer: Customer;
}> {
  const tenantId = requireTenantId();
  if (params.keeperId === params.mergeId) {
    throw new Error('Pick two different customers to merge.');
  }

  const keeperSnap = await getDocs(customersCol(tenantId));
  const customers: Customer[] = keeperSnap.docs.map((snap) => ({
    id: snap.id,
    ...(snap.data() as Omit<Customer, 'id'>)
  }));
  const keeper = customers.find((c) => c.id === params.keeperId);
  const other = customers.find((c) => c.id === params.mergeId);
  if (!keeper || !other) {
    throw new Error('Customer not found.');
  }

  const merged = buildMergedCustomer(keeper, other);
  const mergedName = merged.name;
  const otherNameNorm = normalizeCustomerName(other.name);

  let remappedOrders = 0;
  const ordersSnap = await getDocs(ordersCol(tenantId));
  for (const orderSnap of ordersSnap.docs) {
    const data = orderSnap.data() as {
      customerId?: string;
      customerName?: string;
    };
    const byId = data.customerId === params.mergeId;
    const byName =
      !data.customerId &&
      otherNameNorm &&
      normalizeCustomerName(data.customerName || '') === otherNameNorm;
    if (!byId && !byName) continue;
    await updateDoc(orderSnap.ref, {
      customerId: params.keeperId,
      customerName: mergedName,
      updatedAt: new Date().toISOString()
    });
    remappedOrders += 1;
  }

  let remappedDocuments = 0;
  const docsSnap = await getDocs(documentsCol(tenantId));
  for (const docSnap of docsSnap.docs) {
    const data = docSnap.data() as { customerId?: string; customerName?: string };
    if (data.customerId !== params.mergeId) continue;
    await updateDoc(docSnap.ref, {
      customerId: params.keeperId,
      customerName: mergedName,
      updatedAt: new Date().toISOString()
    });
    remappedDocuments += 1;
  }

  await updateCustomer(merged);
  await deleteDoc(customerDoc(tenantId, params.mergeId));

  return { remappedOrders, remappedDocuments, mergedCustomer: merged };
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
  /** Prefer the longest alias match so "bill to name" does not win as an address column. */
  const findIdx = (headers: string[], aliases: string[]) => {
    let bestIdx = -1;
    let bestLen = -1;
    for (let i = 0; i < headers.length; i += 1) {
      const h = headers[i];
      for (const alias of aliases) {
        if (h === alias || h.includes(alias)) {
          if (alias.length > bestLen) {
            bestIdx = i;
            bestLen = alias.length;
          }
        }
      }
    }
    return bestIdx;
  };

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
  const billNameIdx = findIdx(headers, ['bill to name', 'billing name', 'bill name']);
  const shipNameIdx = findIdx(headers, ['ship to name', 'shipping name', 'ship name']);
  const billIdx = findIdx(headers, [
    'bill to address',
    'billing address',
    'bill address',
    'bill-to address',
    'billto address',
    'billing addr'
  ]);
  const shipIdx = findIdx(headers, [
    'ship to address',
    'shipping address',
    'ship address',
    'ship-to address',
    'shipto address',
    'shipping addr'
  ]);
  // Generic full-address column (QB contact list often uses "Address" with Bill:|Ship: inside).
  let addressIdx = findIdx(headers, ['full address', 'complete address', 'address']);
  if (addressIdx >= 0) {
    const h = headers[addressIdx];
    if (h.includes('email') || h.includes('e-mail') || h.includes('mail')) {
      addressIdx = -1;
    }
    if (addressIdx === billIdx || addressIdx === shipIdx) {
      addressIdx = -1;
    }
  }

  const resolvedNameIdx = nameIdx >= 0 ? nameIdx : 0;

  return rows
    .slice(dataStartIdx)
    .map((cols) => {
      const name = (cols[resolvedNameIdx] || '').trim();
      const email = emailIdx >= 0 ? (cols[emailIdx] || '').trim() : '';
      const phone = phoneIdx >= 0 ? (cols[phoneIdx] || '').trim() : '';
      const notes = notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '';
      const billingName = billNameIdx >= 0 ? (cols[billNameIdx] || '').trim() : '';
      const shippingName = shipNameIdx >= 0 ? (cols[shipNameIdx] || '').trim() : '';
      const billCell = billIdx >= 0 ? (cols[billIdx] || '').trim() : '';
      const shipCell = shipIdx >= 0 ? (cols[shipIdx] || '').trim() : '';
      const addressCell = addressIdx >= 0 ? (cols[addressIdx] || '').trim() : '';
      const addresses = resolveImportedAddresses({ billCell, shipCell, addressCell });

      return withSplitCustomerAddresses({
        name,
        contactEmail: email || undefined,
        phone: phone || undefined,
        billingName: billingName || undefined,
        billingAddress: addresses.billingAddress,
        shippingName: shippingName || undefined,
        shippingAddress: addresses.shippingAddress,
        receiverAddress: addresses.shippingAddress,
        notes: notes || undefined
      });
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
): Promise<{ created: number; addressesUpdated: number }> {
  const tenantId = requireTenantId();
  const existingSnap = await getDocs(customersCol(tenantId));
  const existingByName = new Map<string, Customer>();
  for (const snap of existingSnap.docs) {
    const data = snap.data() as Customer;
    const key = normalizeCustomerName(String(data.name || ''));
    if (!key) continue;
    existingByName.set(key, { ...data, id: snap.id });
  }

  let created = 0;
  let addressesUpdated = 0;
  for (const customer of customers) {
    const incoming = withSplitCustomerAddresses(customer);
    const key = normalizeCustomerName(incoming.name || '');
    if (!key) continue;

    const existing = existingByName.get(key);
    if (!existing) {
      await addCustomer(incoming);
      existingByName.set(key, { ...incoming, id: 'pending', createdAt: '', updatedAt: '' });
      created += 1;
      continue;
    }

    // Fill / repair addresses on existing customers without overwriting good data.
    const existingSplit = withSplitCustomerAddresses(existing);
    const existingHadCombined =
      existingSplit.billingAddress !== existing.billingAddress ||
      (existingSplit.shippingAddress || '') !== (existing.shippingAddress || '') ||
      (existingSplit.receiverAddress || '') !== (existing.receiverAddress || '');

    const nextBilling =
      incoming.billingAddress ||
      (existingHadCombined ? existingSplit.billingAddress : existing.billingAddress);
    const nextShipping =
      incoming.shippingAddress ||
      (existingHadCombined
        ? existingSplit.shippingAddress || existingSplit.receiverAddress
        : existing.shippingAddress || existing.receiverAddress);

    const billingChanged = (nextBilling || '') !== (existing.billingAddress || '');
    const shippingChanged =
      (nextShipping || '') !== (existing.shippingAddress || existing.receiverAddress || '');

    if (!billingChanged && !shippingChanged && !existingHadCombined) continue;

    // Prefer incoming addresses when present; otherwise keep repaired existing split.
    await updateCustomer({
      ...existing,
      billingAddress: incoming.billingAddress || existingSplit.billingAddress || existing.billingAddress,
      shippingAddress:
        incoming.shippingAddress ||
        existingSplit.shippingAddress ||
        existing.shippingAddress ||
        existing.receiverAddress,
      receiverAddress:
        incoming.shippingAddress ||
        existingSplit.shippingAddress ||
        existing.shippingAddress ||
        existing.receiverAddress,
      billingName: existing.billingName || incoming.billingName,
      shippingName: existing.shippingName || incoming.shippingName
    });
    addressesUpdated += 1;
  }
  return { created, addressesUpdated };
}
