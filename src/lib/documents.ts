import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where
} from 'firebase/firestore';
import { db } from '../firebase';
import { CustomerDocument, CustomerDocumentType } from '../types';

let activeTenantId: string | null = null;

export function setDocumentsTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function documentsCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'documents');
}

function documentDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'documents', id);
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

export function subscribeToCustomerDocuments(
  customerId: string,
  callback: (docs: CustomerDocument[]) => void
): () => void {
  if (!activeTenantId || !customerId) {
    callback([]);
    return () => {};
  }

  const tenantId = activeTenantId;
  const q = query(
    documentsCol(tenantId),
    where('customerId', '==', customerId),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const docs: CustomerDocument[] = [];
      snapshot.forEach((snap) => {
        docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
      });
      callback(docs);
    },
    (error) => {
      console.error('Error subscribing to customer documents:', error);
      // Fallback without orderBy if composite index is missing
      getDocs(query(documentsCol(tenantId), where('customerId', '==', customerId)))
        .then((snapshot) => {
          const docs: CustomerDocument[] = [];
          snapshot.forEach((snap) => {
            docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
          });
          docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          callback(docs);
        })
        .catch((err) => {
          console.error('Fallback document fetch failed:', err);
          callback([]);
        });
    }
  );
}

export async function addCustomerDocument(
  data: Omit<CustomerDocument, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const tenantId = requireTenantId();
  const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const payload = sanitizeForFirestore({
    ...data,
    createdAt: now,
    updatedAt: now
  });
  await setDoc(documentDoc(tenantId, id), payload);
  return id;
}

export async function updateCustomerDocument(document: CustomerDocument): Promise<void> {
  const tenantId = requireTenantId();
  const { id, ...rest } = document;
  await updateDoc(
    documentDoc(tenantId, id),
    sanitizeForFirestore({
      ...rest,
      updatedAt: new Date().toISOString()
    })
  );
}

export async function deleteCustomerDocument(documentId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(documentDoc(tenantId, documentId));
}

export async function listAllDocuments(): Promise<CustomerDocument[]> {
  const tenantId = requireTenantId();
  try {
    const snapshot = await getDocs(query(documentsCol(tenantId), orderBy('createdAt', 'desc')));
    const docs: CustomerDocument[] = [];
    snapshot.forEach((snap) => {
      docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
    });
    return docs;
  } catch (err) {
    console.warn('Ordered documents query failed, falling back:', err);
    const snapshot = await getDocs(documentsCol(tenantId));
    const docs: CustomerDocument[] = [];
    snapshot.forEach((snap) => {
      docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
    });
    docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return docs;
  }
}

export function defaultDocumentNumber(
  type: CustomerDocumentType,
  orderNumber?: string
): string {
  const prefix = type === 'estimate' ? 'EST' : 'INV';
  const base = orderNumber && orderNumber !== 'N/A' ? orderNumber : Date.now().toString().slice(-6);
  return `${prefix}-${base}`;
}

export function subscribeToDocuments(
  callback: (docs: CustomerDocument[]) => void
): () => void {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }
  const tenantId = activeTenantId;
  const q = query(documentsCol(tenantId), orderBy('createdAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const docs: CustomerDocument[] = [];
      snapshot.forEach((snap) => {
        docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
      });
      callback(docs);
    },
    (error) => {
      console.error('Error subscribing to documents:', error);
      getDocs(documentsCol(tenantId))
        .then((snapshot) => {
          const docs: CustomerDocument[] = [];
          snapshot.forEach((snap) => {
            docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
          });
          docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          callback(docs);
        })
        .catch((err) => console.error('Documents fallback failed:', err));
    }
  );
}

export function subscribeToDocument(
  documentId: string,
  callback: (doc: CustomerDocument | null) => void
): () => void {
  if (!activeTenantId || !documentId) {
    callback(null);
    return () => {};
  }
  const tenantId = activeTenantId;
  return onSnapshot(
    documentDoc(tenantId, documentId),
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
    },
    (error) => {
      console.error('Error subscribing to document:', error);
      callback(null);
    }
  );
}
