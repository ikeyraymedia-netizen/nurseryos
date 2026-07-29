import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  deleteDoc
} from 'firebase/firestore';
import { db } from '../firebase';
import { Vendor } from '../types';

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
      // Persist empty terms as omitted so "cleared" doesn't leave old value stuck
      paymentTerms: rest.paymentTerms?.trim() || null,
      updatedAt: new Date().toISOString()
    }),
    { merge: true }
  );
}

export async function deleteVendor(vendorId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(vendorDoc(tenantId, vendorId));
}
