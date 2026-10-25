import { auth } from '../firebase';

const DEVICE_KEY = 'nursery_device_id';

export function deviceId(): string {
  let id = '';
  try {
    id = localStorage.getItem(DEVICE_KEY) || '';
  } catch {
    id = '';
  }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    id = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* private mode */
    }
  }
  return id;
}

export class SecurityRequestError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function bearer(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

async function send(path: string, method: 'GET' | 'POST', body?: unknown, withAuth = false): Promise<any> {
  const headers: Record<string, string> = withAuth ? await bearer() : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SecurityRequestError(
      typeof data?.error === 'string' ? data.error : 'Request failed.',
      res.status,
      typeof data?.code === 'string' ? data.code : ''
    );
  }
  return data;
}

export function isStrictOff(err: unknown): boolean {
  return err instanceof SecurityRequestError && (err.status === 404 || err.code === 'strict_off');
}

export async function securityConfig(): Promise<boolean> {
  try {
    const data = await send('/api/security/config', 'GET');
    return data?.strict === true;
  } catch {
    return false;
  }
}

export async function securityChallenge(purpose: 'login' | 'signup' | 'reset'): Promise<string> {
  const data = await send('/api/security/challenge', 'POST', { purpose });
  return String(data.challengeId || '');
}

export async function securityLoginGate(input: {
  purpose: 'login' | 'signup' | 'reset';
  email: string;
  challengeId: string;
  faxNumber?: string;
}): Promise<string> {
  const data = await send('/api/security/login-gate', 'POST', {
    purpose: input.purpose,
    email: input.email,
    challengeId: input.challengeId,
    fax_number: input.faxNumber || ''
  });
  return String(data.ticket || '');
}

export async function securityLoginResult(input: {
  outcome: 'success' | 'failure' | 'mfa_success' | 'mfa_failure';
  email: string;
  ticket?: string;
}): Promise<void> {
  await send('/api/security/login-result', 'POST', input, true);
}

export async function securityOpenSession(rotate: boolean): Promise<void> {
  await send('/api/security/session', 'POST', { rotate }, true);
}

export async function securityLogout(): Promise<void> {
  await send('/api/security/logout', 'POST', {}, true);
}

export async function securityLogoutAll(): Promise<void> {
  await send('/api/security/logout-all', 'POST', {}, true);
}

export async function securityMfaOk(): Promise<void> {
  await send('/api/security/mfa-ok', 'POST', { deviceId: deviceId(), enrolled: true }, true);
}

export async function securityMfaStatus(): Promise<{ lastMfaAt: number | null; deviceKnown: boolean }> {
  const data = await send(`/api/security/mfa-status?deviceId=${encodeURIComponent(deviceId())}`, 'GET', undefined, true);
  return {
    lastMfaAt: typeof data?.lastMfaAt === 'number' ? data.lastMfaAt : null,
    deviceKnown: data?.deviceKnown === true
  };
}

export async function securityPasswordCheck(password: string): Promise<void> {
  await send('/api/security/password-check', 'POST', { password });
}

export async function securityRequestReset(email: string, faxNumber = ''): Promise<string> {
  const challengeId = await securityChallenge('reset');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const data = await send('/api/security/password-reset', 'POST', {
    email,
    challengeId,
    fax_number: faxNumber
  });
  return String(data?.message || 'If an account exists for that email, a reset link is on its way.');
}

export async function securityCompleteReset(token: string, password: string, faxNumber = ''): Promise<void> {
  await send('/api/security/password-reset/complete', 'POST', { token, password, fax_number: faxNumber });
}

export async function securityRevokeMember(tenantId: string, memberUserId: string): Promise<void> {
  try {
    await send('/api/security/revoke-member', 'POST', { tenantId, memberUserId }, true);
  } catch (err) {
    if (isStrictOff(err)) return;
    throw err;
  }
}

export async function securityPermissionChanged(
  tenantId: string,
  memberUserId: string,
  roles: string[]
): Promise<void> {
  try {
    await send('/api/security/permission-changed', 'POST', { tenantId, memberUserId, roles }, true);
  } catch (err) {
    if (isStrictOff(err)) return;
    throw err;
  }
}

function bytesToB64url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let bin = '';
  for (const byte of view) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(value: string): ArrayBuffer {
  const pad = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function passkeyCount(): Promise<number> {
  const data = await send('/api/security/passkey/status', 'GET', undefined, true);
  return Number(data?.count || 0);
}

export async function registerPasskey(): Promise<void> {
  const options = await send('/api/security/passkey/options', 'POST', {}, true);
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rp: options.rp,
      user: {
        id: b64urlToBytes(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      authenticatorSelection: options.authenticatorSelection,
      attestation: 'none'
    }
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey setup was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey) throw new Error('This device did not share a passkey.');
  await send(
    '/api/security/passkey/register',
    'POST',
    {
      id: credential.id,
      publicKey: bytesToB64url(publicKey),
      algorithm: response.getPublicKeyAlgorithm()
    },
    true
  );
}

export async function verifyPasskey(): Promise<void> {
  const options = await send('/api/security/passkey/auth-options', 'POST', {}, true);
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      allowCredentials: (options.allowCredentials || []).map((row: { id: string }) => ({
        id: b64urlToBytes(row.id),
        type: 'public-key' as const
      })),
      userVerification: 'preferred'
    }
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey check was cancelled.');
  const response = credential.response as AuthenticatorAssertionResponse;
  await send(
    '/api/security/passkey/auth',
    'POST',
    {
      id: credential.id,
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      authenticatorData: bytesToB64url(response.authenticatorData),
      signature: bytesToB64url(response.signature)
    },
    true
  );
}
