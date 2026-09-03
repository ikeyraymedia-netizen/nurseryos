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
import { deleteLinkedQuickbooksDocument, fetchHighestQuickbooksDocNumber } from './quickbooks';
import { notifyPushEvent } from './pushNotifications';

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

export async function markCustomerInvoicePaid(
  document: CustomerDocument,
  payment: {
    method: Exclude<CustomerDocument['paymentMethod'], 'stripe' | 'quickbooks' | undefined>;
    reference?: string;
  }
): Promise<void> {
  if (document.type !== 'invoice') {
    throw new Error('Only invoices can be marked paid.');
  }
  await updateCustomerDocument({
    ...document,
    paymentStatus: 'paid',
    paidAt: new Date().toISOString(),
    paymentMethod: payment.method,
    paymentReference: payment.reference?.trim() || undefined,
    stripePaidAmountCents:
      typeof document.stripePaidAmountCents === 'number'
        ? document.stripePaidAmountCents
        : Math.round((document.grandTotal || 0) * 100)
  });

  const tenantId = requireTenantId();
  const amount =
    typeof document.stripePaidAmountCents === 'number'
      ? document.stripePaidAmountCents / 100
      : document.grandTotal || 0;
  void notifyPushEvent({
    tenantId,
    type: 'invoice_paid',
    title: `Payment received · ${document.documentNumber}`,
    body: `${document.billToName || document.customerName || 'Customer'} · $${amount.toFixed(2)}`,
    url: '/?tab=customers'
  });
}

export async function deleteCustomerDocument(documentId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteLinkedQuickbooksDocument({ tenantId, documentId });
  await deleteDoc(documentDoc(tenantId, documentId));
}

/** Invoices/estimates/credit memos created from a plant order. */
export async function listDocumentsForOrder(orderId: string): Promise<CustomerDocument[]> {
  const tenantId = requireTenantId();
  const id = String(orderId || '').trim();
  if (!id) return [];

  try {
    const snapshot = await getDocs(
      query(documentsCol(tenantId), where('orderId', '==', id))
    );
    const docs: CustomerDocument[] = [];
    snapshot.forEach((snap) => {
      docs.push({ id: snap.id, ...(snap.data() as Omit<CustomerDocument, 'id'>) });
    });
    return docs;
  } catch (err) {
    console.warn('listDocumentsForOrder query failed, scanning all docs:', err);
    const all = await listAllDocuments();
    return all.filter((d) => String(d.orderId || '').trim() === id);
  }
}

/**
 * For ops views: drop estimates whose plant order was deleted.
 * Invoices and credit memos are always kept — they are the sales ledger
 * even after the plant order is removed or hidden from the yard list.
 */
export function filterDocumentsForLiveOrders(
  documents: CustomerDocument[],
  liveOrders: Array<{ id: string }> | Set<string>
): CustomerDocument[] {
  const liveIds =
    liveOrders instanceof Set ? liveOrders : new Set(liveOrders.map((o) => o.id));
  return documents.filter((d) => {
    if (d.type === 'invoice' || d.type === 'credit_memo') return true;
    const orderId = String(d.orderId || '').trim();
    if (!orderId) return true;
    return liveIds.has(orderId);
  });
}

/** All invoices + credit memos for sales totals (never drop by order lifecycle). */
export function salesLedgerDocuments(
  documents: CustomerDocument[]
): CustomerDocument[] {
  return documents.filter((d) => d.type === 'invoice' || d.type === 'credit_memo');
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

export const DOCUMENT_NUMBER_START = 1000;

/** True when a number is an estimate sequence (EST-1234), not an invoice. */
export function isEstimateDocumentNumber(
  documentNumber: string | undefined | null
): boolean {
  return /^EST[- ]?\d+/i.test(String(documentNumber || '').trim());
}

/** Extract a sequential integer from a document number, if it looks sequential. */
export function parseSequentialDocumentNumber(
  documentNumber: string | undefined | null,
  type: CustomerDocumentType
): number | null {
  const raw = String(documentNumber || '').trim();
  if (!raw) return null;
  if (type === 'estimate') {
    const est = raw.match(/^EST-(\d+)$/i);
    if (est) return Number(est[1]);
    return null;
  }
  if (type === 'credit_memo') {
    const cm = raw.match(/^CM-(\d+)$/i);
    if (cm) return Number(cm[1]);
    return null;
  }
  // Invoices: plain digits (1000) or legacy INV-1000
  const inv = raw.match(/^(?:INV-)?(\d+)$/i);
  if (!inv) return null;
  return Number(inv[1]);
}

/**
 * Next document number for this nursery.
 * Invoices: 1000, 1001…
 * Estimates: EST-1000…
 * Credit memos: CM-1000…
 * Continues from the highest existing number of that type (never below 1000).
 * When QuickBooks is connected, also skips numbers already used in QBO
 * (e.g. invoices created only in QuickBooks).
 */
export async function nextDocumentNumber(
  type: CustomerDocumentType,
  opts?: { considerQuickbooks?: boolean; tenantId?: string }
): Promise<string> {
  const docs = await listAllDocuments();
  let max = DOCUMENT_NUMBER_START - 1;
  for (const d of docs) {
    if (d.type !== type) continue;
    const n = parseSequentialDocumentNumber(d.documentNumber, type);
    if (n != null && Number.isFinite(n) && n > max) max = n;
    // Also honor numbers QuickBooks assigned (may be plain digits without EST-/CM-).
    const qboRaw = String(d.qboDocNumber || '').trim();
    if (qboRaw) {
      const qboN =
        parseSequentialDocumentNumber(qboRaw, type) ??
        (/^\d+$/.test(qboRaw) ? Number(qboRaw) : null);
      if (qboN != null && Number.isFinite(qboN) && qboN > max) max = qboN;
    }
  }

  if (opts?.considerQuickbooks) {
    const tenantId = opts.tenantId || activeTenantId;
    if (tenantId) {
      try {
        const qboMax = await fetchHighestQuickbooksDocNumber(tenantId, type);
        if (qboMax != null && qboMax > max) max = qboMax;
      } catch (err) {
        console.warn('[documents] could not read QBO doc numbers', err);
      }
    }
  }

  const next = Math.max(max + 1, DOCUMENT_NUMBER_START);
  if (type === 'estimate') return `EST-${next}`;
  if (type === 'credit_memo') return `CM-${next}`;
  return String(next);
}

/** Sync fallback before async allocation finishes. */
export function defaultDocumentNumber(
  type: CustomerDocumentType,
  _orderNumber?: string
): string {
  if (type === 'estimate') return `EST-${DOCUMENT_NUMBER_START}`;
  if (type === 'credit_memo') return `CM-${DOCUMENT_NUMBER_START}`;
  return String(DOCUMENT_NUMBER_START);
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
