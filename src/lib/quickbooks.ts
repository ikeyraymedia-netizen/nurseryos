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
  companyName?: string | null;
}

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // non-JSON body
  }
  if (text?.trim()) return text.trim().slice(0, 240);
  return `Request failed (${res.status})`;
}

export async function fetchQuickbooksStatus(tenantId: string): Promise<QuickbooksStatus> {
  const res = await fetch(`/api/quickbooks/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as QuickbooksStatus;
}

export async function startQuickbooksConnect(tenantId: string): Promise<string> {
  const res = await fetch('/api/quickbooks/connect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  if (!res.ok) throw new Error(await readApiError(res));
  const data = (await res.json()) as { authorizeUrl?: string };
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
}): Promise<{
  qboInvoiceId: string;
  qboDocType: string;
  qboDocNumber?: string | null;
  customerName?: string | null;
  totalAmt?: number | null;
  environment?: string;
  companyName?: string | null;
  openUrl?: string | null;
  sandboxUrl?: string | null;
  verified?: boolean;
}> {
  const res = await fetch('/api/quickbooks/push-invoice', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to push to QuickBooks.');
  return {
    qboInvoiceId: String(data.qboInvoiceId),
    qboDocType: String(data.qboDocType || 'invoice'),
    qboDocNumber: data.qboDocNumber ? String(data.qboDocNumber) : null,
    customerName: data.customerName ? String(data.customerName) : null,
    totalAmt: data.totalAmt != null ? Number(data.totalAmt) : null,
    environment: data.environment ? String(data.environment) : null,
    companyName: data.companyName ? String(data.companyName) : null,
    openUrl: data.openUrl ? String(data.openUrl) : null,
    sandboxUrl: data.sandboxUrl ? String(data.sandboxUrl) : null,
    verified: Boolean(data.verified)
  };
}

export async function fetchRecentQuickbooksInvoices(tenantId: string): Promise<{
  environment: string;
  companyName: string | null;
  realmId: string;
  invoices: Array<{
    id: string;
    docNumber: string | null;
    txnDate: string | null;
    totalAmt: number | null;
    customerName: string | null;
    openUrl: string;
  }>;
}> {
  const res = await fetch(
    `/api/quickbooks/recent-invoices?tenantId=${encodeURIComponent(tenantId)}`,
    { headers: await authHeaders() }
  );
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}
