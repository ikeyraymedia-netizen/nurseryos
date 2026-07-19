import { auth } from '../firebase';

async function authHeaders(): Promise<HeadersInit> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

export interface QuickbooksStatus {
  connected: boolean;
  realmId: string | null;
  connectedAt: string | null;
  environment: 'sandbox' | 'production';
  configured: boolean;
}

export async function fetchQuickbooksStatus(tenantId: string): Promise<QuickbooksStatus> {
  const res = await fetch(`/api/quickbooks/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to load QuickBooks status.');
  return data as QuickbooksStatus;
}

export async function startQuickbooksConnect(tenantId: string): Promise<string> {
  const res = await fetch('/api/quickbooks/connect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to start QuickBooks connect.');
  if (!data?.authorizeUrl) throw new Error('No QuickBooks authorize URL returned.');
  return String(data.authorizeUrl);
}

export async function disconnectQuickbooks(tenantId: string): Promise<void> {
  const res = await fetch('/api/quickbooks/disconnect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to disconnect QuickBooks.');
}

export async function pushDocumentToQuickbooks(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ qboInvoiceId: string; qboDocType: string }> {
  const res = await fetch('/api/quickbooks/push-invoice', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to push to QuickBooks.');
  return {
    qboInvoiceId: String(data.qboInvoiceId),
    qboDocType: String(data.qboDocType || 'invoice')
  };
}
