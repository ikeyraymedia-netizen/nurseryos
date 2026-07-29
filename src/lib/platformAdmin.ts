import { auth } from '../firebase';
import { TenantModuleId } from '../types';

export type AccessRequestStatus = 'pending' | 'approved' | 'declined';

export interface AccessRequest {
  id: string;
  displayName: string;
  nurseryName: string;
  email: string;
  message: string;
  locale: string;
  status: AccessRequestStatus;
  createdAt: string;
  updatedAt: string;
  approvedTenantId?: string | null;
  approvedAt?: string | null;
  declinedAt?: string | null;
}

async function authHeaders(): Promise<HeadersInit> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `Request failed (${res.status})`;
}

export async function listAccessRequests(
  status: AccessRequestStatus | 'all' = 'pending'
): Promise<AccessRequest[]> {
  const res = await fetch(`/api/platform/access-requests?status=${encodeURIComponent(status)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { requests?: AccessRequest[] };
  return data.requests || [];
}

export async function declineAccessRequest(requestId: string): Promise<void> {
  const res = await fetch(`/api/platform/access-requests/${encodeURIComponent(requestId)}/decline`, {
    method: 'POST',
    headers: await authHeaders(),
    body: '{}'
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function provisionNursery(input: {
  displayName: string;
  nurseryName: string;
  email: string;
  locale?: string;
  modules: TenantModuleId[];
  accessRequestId?: string;
  sendWelcomeEmail?: boolean;
}): Promise<{ tenantId: string; userCreated: boolean; resetLinkSent: boolean }> {
  const res = await fetch('/api/platform/provision-nursery', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      displayName: input.displayName.trim(),
      nurseryName: input.nurseryName.trim(),
      email: input.email.trim(),
      locale: input.locale || 'en',
      modules: input.modules,
      accessRequestId: input.accessRequestId || undefined,
      sendWelcomeEmail: input.sendWelcomeEmail !== false
    })
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as {
    tenantId: string;
    userCreated?: boolean;
    resetLinkSent?: boolean;
  };
  return {
    tenantId: data.tenantId,
    userCreated: Boolean(data.userCreated),
    resetLinkSent: Boolean(data.resetLinkSent)
  };
}
