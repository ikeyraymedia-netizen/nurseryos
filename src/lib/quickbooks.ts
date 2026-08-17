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
  qboInvoiceLink?: string | null;
  customerName?: string | null;
  totalAmt?: number | null;
  lineCount?: number | null;
  linePreview?: string[];
  environment?: string;
  companyName?: string | null;
  openUrl?: string | null;
  sandboxUrl?: string | null;
  verified?: boolean;
  reused?: boolean;
  updated?: boolean;
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
    qboInvoiceLink: data.qboInvoiceLink ? String(data.qboInvoiceLink) : null,
    customerName: data.customerName ? String(data.customerName) : null,
    totalAmt: data.totalAmt != null ? Number(data.totalAmt) : null,
    lineCount: data.lineCount != null ? Number(data.lineCount) : null,
    linePreview: Array.isArray(data.linePreview) ? data.linePreview.map(String) : [],
    environment: data.environment ? String(data.environment) : null,
    companyName: data.companyName ? String(data.companyName) : null,
    openUrl: data.openUrl ? String(data.openUrl) : null,
    sandboxUrl: data.sandboxUrl ? String(data.sandboxUrl) : null,
    verified: Boolean(data.verified),
    reused: Boolean(data.reused),
    updated: Boolean(data.updated)
  };
}

/** Push invoice if needed and return the Intuit hosted pay URL. */
export async function ensureQboPayLink(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ url: string; qboInvoiceId: string }> {
  const res = await fetch('/api/quickbooks/ensure-pay-link', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to get QuickBooks pay link.');
  }
  const url = String((data as any)?.url || '').trim();
  if (!url) throw new Error('QuickBooks did not return a pay link URL.');
  return {
    url,
    qboInvoiceId: String((data as any)?.qboInvoiceId || '')
  };
}

/** Check QBO invoice balance and mark NurseryOS paid when Balance is 0. */
export async function refreshQboPaymentStatus(params: {
  tenantId: string;
  documentId: string;
}): Promise<{
  paid: boolean;
  balance?: number | null;
  qboInvoiceLink?: string | null;
  paymentStatus?: string;
}> {
  const res = await fetch('/api/quickbooks/refresh-payment-status', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to refresh QuickBooks payment status.');
  }
  return {
    paid: Boolean((data as any)?.paid),
    balance: (data as any)?.balance != null ? Number((data as any).balance) : null,
    qboInvoiceLink: (data as any)?.qboInvoiceLink
      ? String((data as any).qboInvoiceLink)
      : null,
    paymentStatus: (data as any)?.paymentStatus
      ? String((data as any).paymentStatus)
      : undefined
  };
}

/** Sync a paid NurseryOS invoice as a QuickBooks Receive Payment. */
export async function pushPaymentToQuickbooks(params: {
  tenantId: string;
  documentId: string;
}): Promise<{
  synced: boolean;
  skipped?: boolean;
  reason?: string | null;
  qboPaymentId?: string | null;
}> {
  const res = await fetch('/api/quickbooks/push-payment', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to sync payment to QuickBooks.');
  }
  return {
    synced: Boolean((data as any)?.synced),
    skipped: Boolean((data as any)?.skipped),
    reason: (data as any)?.reason ? String((data as any).reason) : null,
    qboPaymentId: (data as any)?.qboPaymentId ? String((data as any).qboPaymentId) : null
  };
}

/** Push a vendor bill to QuickBooks Online as an AP Bill. */
export async function pushVendorBillToQuickbooks(params: {
  tenantId: string;
  billId: string;
}): Promise<{
  qboBillId: string;
  qboDocNumber?: string | null;
  vendorName?: string | null;
  totalAmt?: number | null;
  environment?: string | null;
  companyName?: string | null;
  openUrl?: string | null;
  alreadySynced?: boolean;
  updated?: boolean;
}> {
  const res = await fetch('/api/quickbooks/push-bill', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to push bill to QuickBooks.');
  }
  return {
    qboBillId: String((data as any).qboBillId || ''),
    qboDocNumber: (data as any).qboDocNumber ? String((data as any).qboDocNumber) : null,
    vendorName: (data as any).vendorName ? String((data as any).vendorName) : null,
    totalAmt: (data as any).totalAmt != null ? Number((data as any).totalAmt) : null,
    environment: (data as any).environment ? String((data as any).environment) : null,
    companyName: (data as any).companyName ? String((data as any).companyName) : null,
    openUrl: (data as any).openUrl ? String((data as any).openUrl) : null,
    alreadySynced: Boolean((data as any).alreadySynced),
    updated: Boolean((data as any).updated)
  };
}

/** Sync a paid NurseryOS vendor bill as a QuickBooks Bill Payment. */
export async function pushBillPaymentToQuickbooks(params: {
  tenantId: string;
  billId: string;
}): Promise<{
  synced: boolean;
  skipped?: boolean;
  reason?: string | null;
  qboBillPaymentId?: string | null;
}> {
  const res = await fetch('/api/quickbooks/push-bill-payment', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to sync bill payment to QuickBooks.');
  }
  return {
    synced: Boolean((data as any)?.synced),
    skipped: Boolean((data as any)?.skipped),
    reason: (data as any)?.reason ? String((data as any).reason) : null,
    qboBillPaymentId: (data as any)?.qboBillPaymentId
      ? String((data as any).qboBillPaymentId)
      : null
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

export async function deleteLinkedQuickbooksDocument(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ skipped?: boolean; deleted?: boolean; voided?: boolean; alreadyGone?: boolean }> {
  const res = await fetch('/api/quickbooks/delete-document', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to delete this document in QuickBooks.');
  }
  return data as any;
}

export async function deleteLinkedQuickbooksBill(params: {
  tenantId: string;
  billId: string;
}): Promise<{ skipped?: boolean; deleted?: boolean; voided?: boolean; alreadyGone?: boolean }> {
  const res = await fetch('/api/quickbooks/delete-bill', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || 'Failed to delete this bill in QuickBooks.');
  }
  return data as any;
}
