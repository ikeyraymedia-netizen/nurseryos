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

export interface EmailIdentity {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
}

export interface EmailStatus {
  configured: boolean;
  platformReady?: boolean;
  fromEmail: string | null;
  fromName: string | null;
  identities?: EmailIdentity[];
  defaultIdentityId?: string | null;
  smtpHost?: string | null;
  smtpUser?: string | null;
  configuredAt: string | null;
}

export function identitiesFromStatus(status: EmailStatus | null | undefined): EmailIdentity[] {
  if (!status) return [];
  if (Array.isArray(status.identities) && status.identities.length) {
    return status.identities.filter((row) => row?.fromEmail);
  }
  if (status.fromEmail) {
    return [
      {
        id: status.defaultIdentityId || 'primary',
        label: status.fromName || 'Default',
        fromName: status.fromName || '',
        fromEmail: status.fromEmail
      }
    ];
  }
  return [];
}

export function defaultIdentityEmail(status: EmailStatus | null | undefined): string {
  const rows = identitiesFromStatus(status);
  if (!rows.length) return '';
  const preferred = rows.find((row) => row.id === status?.defaultIdentityId);
  return (preferred || rows[0]).fromEmail;
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
  fromEmail?: string;
  fromName?: string;
  identities?: EmailIdentity[];
  defaultIdentityId?: string;
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_CC_RECIPIENTS = 20;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(String(value || '').trim());
}

/** Split comma / semicolon / newline lists into unique trimmed emails. */
export function splitEmailList(value: string | string[] | undefined | null): string[] {
  const parts = Array.isArray(value)
    ? value.flatMap((entry) => String(entry || '').split(/[,;\s]+/))
    : String(value || '').split(/[,;\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function parseCcEmails(
  value: string | string[] | undefined | null,
  to?: string
): { cc: string[]; invalid: string[] } {
  const toNorm = String(to || '').trim().toLowerCase();
  const cc: string[] = [];
  const invalid: string[] = [];
  for (const email of splitEmailList(value)) {
    if (toNorm && email === toNorm) continue;
    if (!looksLikeEmail(email)) {
      invalid.push(email);
      continue;
    }
    cc.push(email);
  }
  return { cc, invalid };
}

export function mailtoUrl(params: {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
}): string {
  const query = [
    params.cc?.length ? `cc=${encodeURIComponent(params.cc.join(','))}` : '',
    `subject=${encodeURIComponent(params.subject)}`,
    `body=${encodeURIComponent(params.body)}`
  ]
    .filter(Boolean)
    .join('&');
  return `mailto:${encodeURIComponent(params.to)}?${query}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function sendInvoiceEmail(params: {
  tenantId: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html: string;
  fromName?: string;
  fromEmail?: string;
  pdfAttachment?: { filename: string; content: string };
}): Promise<{
  success: boolean;
  code?: string;
  message?: string;
  error?: string;
  fromEmail?: string;
  fromName?: string;
  messageId?: string;
  cc?: string[];
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

/** Same Resend path as invoices — availability lists, notices, etc. */
export const sendTenantEmail = sendInvoiceEmail;
