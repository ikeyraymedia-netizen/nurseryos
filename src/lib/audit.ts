import { addDoc, collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { db } from '../firebase';

let activeTenantId: string | null = null;

export function setAuditTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

export interface AuditEvent {
  id?: string;
  action: string;
  summary: string;
  actorEmail?: string;
  meta?: Record<string, string | number | boolean | null>;
  createdAt: string;
}

function requireTenantId(): string {
  if (!activeTenantId) throw new Error('No active nursery selected.');
  return activeTenantId;
}

function auditCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'auditLog');
}

export async function logAuditEvent(input: {
  action: string;
  summary: string;
  actorEmail?: string;
  meta?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  if (!activeTenantId) return;
  try {
    const tenantId = requireTenantId();
    await addDoc(auditCol(tenantId), {
      action: input.action,
      summary: input.summary,
      actorEmail: input.actorEmail || null,
      meta: input.meta || null,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.warn('Audit log write skipped:', err);
  }
}

export async function listRecentAuditEvents(max = 50): Promise<AuditEvent[]> {
  const tenantId = requireTenantId();
  try {
    const snap = await getDocs(query(auditCol(tenantId), orderBy('createdAt', 'desc'), limit(max)));
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditEvent, 'id'>) }));
  } catch {
    const snap = await getDocs(auditCol(tenantId));
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<AuditEvent, 'id'>) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, max);
  }
}
