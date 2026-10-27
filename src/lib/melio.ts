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

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as T;
}

export interface MelioFundingAccount {
  id: string;
  label: string;
  last4: string | null;
  isVerified: boolean;
  type: string | null;
}

export interface MelioStatus {
  configured: boolean;
  environment: 'sandbox' | 'production';
  apiOk: boolean;
  apiError: string | null;
  partnerName: string | null;
  connected: boolean;
  entityId: string | null;
  entityName: string | null;
  kycStatus: string | null;
  fundingAccountId: string | null;
  fundingAccountLast4: string | null;
  fundingAccountName: string | null;
  connectedAt: string | null;
  accounts: MelioFundingAccount[];
  ready: boolean;
}

export interface MelioEntityInput {
  legalName: string;
  name?: string;
  ein: string;
  phoneNumber: string;
  businessType?: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  ownerFirstName: string;
  ownerLastName: string;
  ownerEmail: string;
  ownerDateOfBirth: string;
}

export async function fetchMelioConfig(): Promise<{
  configured: boolean;
  melio: boolean;
  firebaseAdmin: boolean;
  environment: 'sandbox' | 'production';
  sonarPublishableKey: string | null;
}> {
  const res = await fetch('/api/melio/config-status');
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchMelioStatus(tenantId: string): Promise<MelioStatus> {
  const res = await fetch(`/api/melio/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as MelioStatus;
}

/** For Purchasing bill pay — available to office (not only admin). */
export async function fetchMelioReady(tenantId: string): Promise<boolean> {
  const ctx = await fetchMelioPayContext(tenantId);
  return ctx.ready;
}

export async function fetchMelioPayContext(
  tenantId: string
): Promise<{ ready: boolean; entityId: string | null }> {
  const res = await fetch(`/api/melio/ready?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) return { ready: false, entityId: null };
  const data = (await res.json()) as { ready?: boolean; entityId?: string | null };
  return { ready: Boolean(data.ready), entityId: data.entityId || null };
}

export function linkMelioEntity(tenantId: string, entityId: string) {
  return postJson<{ entityId: string; kycStatus: string | null }>('/api/melio/link-entity', {
    tenantId,
    entityId
  });
}

/** Caller must show Melio's terms disclosure on the same action that calls this. */
export function createMelioEntity(
  tenantId: string,
  entity: MelioEntityInput,
  sonarToken?: string
) {
  return postJson<{ entityId: string; kycStatus: string | null }>('/api/melio/create-entity', {
    tenantId,
    entity,
    termsAccepted: true,
    ...(sonarToken ? { sonarToken } : {})
  });
}

export function createMelioFundingLink(tenantId: string, sonarToken?: string) {
  return postJson<{ url: string; expiration: string | null }>('/api/melio/funding-link', {
    tenantId,
    ...(sonarToken ? { sonarToken } : {})
  });
}

export function createMelioVerifyLink(tenantId: string, accountId: string, sonarToken?: string) {
  return postJson<{ url: string; expiration: string | null }>('/api/melio/verify-link', {
    tenantId,
    accountId,
    ...(sonarToken ? { sonarToken } : {})
  });
}

export function selectMelioFunding(tenantId: string, accountId: string) {
  return postJson<{ fundingAccountId: string }>('/api/melio/select-funding', {
    tenantId,
    accountId
  });
}

export function disconnectMelio(tenantId: string) {
  return postJson<{ ok: boolean }>('/api/melio/disconnect', { tenantId });
}

export interface MelioPayQuote {
  amountCents: number;
  feeCents: number;
  totalCents: number;
  deliveryDate: string | null;
  deliveryPreference: string;
  vendorName: string;
  last4: string | null;
  billCount: number;
}

export function quoteVendorBillMelio(params: {
  tenantId: string;
  billIds: string[];
  sonarToken?: string;
}) {
  return postJson<MelioPayQuote>('/api/melio/quote-bill', params);
}

export function payVendorBillMelio(params: {
  tenantId: string;
  billIds: string[];
  sonarToken?: string;
}) {
  return postJson<{
    paymentId: string;
    status: string;
    amount: number;
    billIds: string[];
    billCount: number;
    vendorName: string;
    last4: string | null;
    provider: 'melio';
  }>('/api/melio/pay-bill', params);
}

export function refreshVendorBillMelioPayment(params: { tenantId: string; billId: string }) {
  return postJson<{ paymentId: string; status: string | null; provider: 'melio' }>(
    '/api/melio/refresh-bill',
    params
  );
}
