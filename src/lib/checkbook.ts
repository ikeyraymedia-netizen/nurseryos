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

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // non-JSON
  }
  if (text?.trim()) return text.trim().slice(0, 240);
  return `Request failed (${res.status})`;
}

export interface CheckbookStatus {
  connected: boolean;
  environment: 'sandbox' | 'production' | null;
  apiBase?: string | null;
  publishableKeyLast4: string | null;
  hasWebhookKey: boolean;
  connectedAt: string | null;
  webhookUrl: string;
}

export async function fetchCheckbookStatus(tenantId: string): Promise<CheckbookStatus> {
  const res = await fetch(`/api/checkbook/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as CheckbookStatus;
}

export async function connectCheckbook(params: {
  tenantId: string;
  publishableKey: string;
  secretKey: string;
  webhookKey?: string;
  environment: 'sandbox' | 'production';
}): Promise<CheckbookStatus> {
  const res = await fetch('/api/checkbook/connect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as CheckbookStatus;
}

export async function disconnectCheckbook(tenantId: string): Promise<void> {
  const res = await fetch('/api/checkbook/disconnect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  if (!res.ok) throw new Error(await readApiError(res));
}

export async function payVendorBillAch(params: {
  tenantId: string;
  billId: string;
  recipientEmail?: string;
}): Promise<{ paymentId: string; status: string; recipient: string; amount: number }> {
  const res = await fetch('/api/checkbook/pay-bill', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as {
    paymentId: string;
    status: string;
    recipient: string;
    amount: number;
  };
}

export async function refreshVendorBillPayment(params: {
  tenantId: string;
  billId: string;
}): Promise<{ paymentId: string; status: string | null }> {
  const res = await fetch('/api/checkbook/refresh-bill', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as { paymentId: string; status: string | null };
}
