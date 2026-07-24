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

export interface StripeStatus {
  connected: boolean;
  accountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  connectedAt: string | null;
  configured: boolean;
}

export async function fetchStripeStatus(tenantId: string): Promise<StripeStatus> {
  const res = await fetch(`/api/stripe/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as StripeStatus;
}

export async function startStripeConnect(tenantId: string): Promise<{
  onboardingUrl: string;
  accountId: string;
}> {
  const res = await fetch('/api/stripe/connect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  if (!res.ok) throw new Error(await readApiError(res));
  const data = (await res.json()) as { onboardingUrl?: string; accountId?: string };
  if (!data?.onboardingUrl) throw new Error('No Stripe onboarding URL returned.');
  return {
    onboardingUrl: String(data.onboardingUrl),
    accountId: String(data.accountId || '')
  };
}

export async function disconnectStripe(tenantId: string): Promise<void> {
  const res = await fetch('/api/stripe/disconnect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || 'Failed to disconnect Stripe.');
}

export async function createInvoiceCheckout(params: {
  tenantId: string;
  documentId: string;
}): Promise<{ url: string; sessionId: string }> {
  const res = await fetch('/api/stripe/create-checkout', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Failed to create Stripe checkout.');
  if (!data?.url) throw new Error('No checkout URL returned.');
  return { url: String(data.url), sessionId: String(data.sessionId || '') };
}

/** Sync invoice paid status after Checkout redirect (or when webhook is delayed/missing). */
export async function confirmInvoicePayment(params: {
  tenantId: string;
  documentId: string;
  sessionId?: string;
}): Promise<{ paid: boolean; alreadyPaid?: boolean; paymentStatus?: string }> {
  const res = await fetch('/api/stripe/confirm-payment', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || 'Failed to confirm Stripe payment.');
  return data as { paid: boolean; alreadyPaid?: boolean; paymentStatus?: string };
}
