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
    const data = JSON.parse(text) as { error?: string; message?: string };
    if (data?.error) return data.error;
    if (data?.message) return data.message;
  } catch {
    // non-JSON
  }
  if (text?.trim()) return text.trim().slice(0, 240);
  return `Request failed (${res.status})`;
}

export interface EmailStatus {
  configured: boolean;
  fromEmail: string | null;
  fromName: string | null;
  smtpHost: string | null;
  smtpUser: string | null;
  configuredAt: string | null;
}

export async function fetchEmailStatus(tenantId: string): Promise<EmailStatus> {
  const res = await fetch(`/api/email/status?tenantId=${encodeURIComponent(tenantId)}`, {
    headers: await authHeaders()
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as EmailStatus;
}

export async function saveEmailConfig(params: {
  tenantId: string;
  fromEmail: string;
  fromName?: string;
  smtpPass?: string;
  smtpUser?: string;
  smtpHost?: string;
  smtpPort?: number;
}): Promise<EmailStatus> {
  const res = await fetch('/api/email/config', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as EmailStatus;
}

export async function disconnectEmail(tenantId: string): Promise<void> {
  const res = await fetch('/api/email/disconnect', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ tenantId })
  });
  if (!res.ok) throw new Error(await readApiError(res));
}

export async function sendInvoiceEmail(params: {
  tenantId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName?: string;
}): Promise<{
  success: boolean;
  code?: string;
  message?: string;
  error?: string;
  fromEmail?: string;
  fromName?: string;
  messageId?: string;
}> {
  const res = await fetch('/api/send-invoice', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || (data as any)?.details || 'Failed to send email.');
  }
  return data as any;
}
