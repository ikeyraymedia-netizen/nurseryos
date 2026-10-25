/**
 * Melio security policy (pure functions).
 *
 * Firebase Authentication stores passwords as salted scrypt hashes. NurseryOS
 * does not keep a second password database and must not log passwords, MFA
 * codes, or reset tokens. These helpers only decide whether a password, session,
 * MFA challenge, or reset link is acceptable.
 *
 * MELIO_SECURITY_STRICT defaults off. When it is off, callers keep today's
 * behavior and should not apply the strict branches below.
 */
import { COMMON_PASSWORDS } from './commonPasswords';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
export const MFA_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
export const MFA_FRESH_MS = 10 * 60 * 1000;
export const RESET_LINK_TTL_MS = 15 * 60 * 1000;

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export const BOT_MIN_AGE_MS = 1500;
export const BOT_MAX_AGE_MS = 10 * 60 * 1000;
export const AUTH_RATE_LIMIT = 20;
export const AUTH_RATE_WINDOW_MS = 10 * 60 * 1000;

export const SHARED_ACCOUNT_DEVICE_LIMIT = 4;
export const SHARED_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PasswordRejectReason =
  | 'too_short'
  | 'too_long'
  | 'common'
  | 'breached'
  | 'breach_check_unavailable';

export type SessionFreshness = 'ok' | 'idle' | 'max';
export type ResetTokenStatus = 'ok' | 'missing' | 'used' | 'expired';

const SECRET_FIELD =
  /password|passcode|secret|token|otp|mfacode|verification|authorization|cookie|sessionid|session_id|oob|resetlink|bearer/i;

/** True only for explicit on-values. Unset, empty, "false", and "0" stay off. */
export function parseMelioSecurityStrict(value: string | undefined | null): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isCommonPassword(
  password: string,
  list: readonly string[] = COMMON_PASSWORDS
): boolean {
  const folded = password.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === folded);
}

export function passwordLengthFailure(password: string): 'too_short' | 'too_long' | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}

/**
 * Have I Been Pwned range responses are `SUFFIX:COUNT` lines. Only the first
 * 5 hex chars of the SHA-1 were sent; this checks whether the rest of the hash
 * is listed with a positive count. Padding rows (count 0) are ignored.
 */
export function hibpSuffixIsBreached(fullHashHex: string, body: string): boolean {
  const suffix = fullHashHex.slice(5).toUpperCase();
  if (suffix.length < 10) return false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [listed, countRaw] = trimmed.split(':');
    if (!listed || listed.toUpperCase() !== suffix) continue;
    if (Number(countRaw || 0) > 0) return true;
  }
  return false;
}

export async function sha1Hex(text: string): Promise<string> {
  return digestHex('SHA-1', text);
}

export async function sha256Hex(text: string): Promise<string> {
  return digestHex('SHA-256', text);
}

async function digestHex(algorithm: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is not available.');
  const digest = await subtle.digest(algorithm, new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Check a new password locally and against a breach-range lookup.
 * `lookupRange` receives only the 5-character SHA-1 prefix, never the password.
 * A null body means the breach list could not be checked; that fails closed.
 */
export async function assessPassword(
  password: string,
  lookupRange: (prefix: string) => Promise<string | null>
): Promise<{ ok: boolean; reason: PasswordRejectReason | null }> {
  const length = passwordLengthFailure(password);
  if (length) return { ok: false, reason: length };
  if (isCommonPassword(password)) return { ok: false, reason: 'common' };

  let hash: string;
  try {
    hash = await sha1Hex(password);
  } catch {
    return { ok: false, reason: 'breach_check_unavailable' };
  }
  const prefix = hash.slice(0, 5);
  let body: string | null;
  try {
    body = await lookupRange(prefix);
  } catch {
    body = null;
  }
  if (body == null) return { ok: false, reason: 'breach_check_unavailable' };
  if (hibpSuffixIsBreached(hash, body)) return { ok: false, reason: 'breached' };
  return { ok: true, reason: null };
}

export function decideLockout(input: {
  failureTimestamps: number[];
  now: number;
  lockedUntil: number | null;
}): { locked: boolean; lockedUntil: number | null; failuresInWindow: number } {
  if (input.lockedUntil != null && input.lockedUntil > input.now) {
    const windowStart = input.now - LOCKOUT_WINDOW_MS;
    return {
      locked: true,
      lockedUntil: input.lockedUntil,
      failuresInWindow: input.failureTimestamps.filter((stamp) => stamp >= windowStart).length
    };
  }
  const windowStart = input.now - LOCKOUT_WINDOW_MS;
  const recent = input.failureTimestamps.filter((stamp) => stamp >= windowStart && stamp <= input.now);
  if (recent.length >= LOCKOUT_MAX_FAILURES) {
    return {
      locked: true,
      lockedUntil: input.now + LOCKOUT_DURATION_MS,
      failuresInWindow: recent.length
    };
  }
  return { locked: false, lockedUntil: null, failuresInWindow: recent.length };
}

export function recordFailure(
  failureTimestamps: number[],
  now: number
): number[] {
  const windowStart = now - LOCKOUT_WINDOW_MS;
  return [...failureTimestamps.filter((stamp) => stamp >= windowStart), now];
}

export function sessionFreshness(input: {
  createdAt: number;
  lastActivityAt: number;
  now: number;
}): SessionFreshness {
  if (input.now - input.createdAt >= MAX_SESSION_MS) return 'max';
  if (input.now - input.lastActivityAt >= IDLE_TIMEOUT_MS) return 'idle';
  return 'ok';
}

/**
 * Flag off: owners and admins only (today's rule).
 * Flag on: every signed-in person, with no role exception.
 */
export function accountRequiresMfa(input: {
  strict: boolean;
  signedIn: boolean;
  isOwnerOrAdmin: boolean;
}): boolean {
  if (!input.signedIn) return false;
  if (input.strict) return true;
  return input.isOwnerOrAdmin;
}

export function mfaSkipAllowed(strict: boolean): boolean {
  return !strict;
}

/** New device, or the last authenticator check is 30 days old or older. */
export function mfaStepUpRequired(input: {
  strict: boolean;
  totpEnrolled: boolean;
  deviceKnown: boolean;
  lastMfaAt: number | null;
  now: number;
}): boolean {
  if (!input.strict || !input.totpEnrolled) return false;
  if (!input.deviceKnown || input.lastMfaAt == null) return true;
  return input.now - input.lastMfaAt >= MFA_RECHECK_MS;
}

export function mfaIsFresh(lastMfaAt: number | null, now: number): boolean {
  if (lastMfaAt == null) return false;
  return now - lastMfaAt <= MFA_FRESH_MS;
}

export function resetTokenStatus(
  token: { expiresAt: number; usedAt: number | null } | null,
  now: number
): ResetTokenStatus {
  if (!token) return 'missing';
  if (token.usedAt != null) return 'used';
  if (token.expiresAt <= now) return 'expired';
  return 'ok';
}

export function botChallengeStatus(input: {
  honeypot: string;
  createdAt: number;
  now: number;
  used: boolean;
}): 'ok' | 'bot' | 'too_fast' | 'expired' | 'used' {
  if (input.used) return 'used';
  if (input.honeypot.trim()) return 'bot';
  const age = input.now - input.createdAt;
  if (age < BOT_MIN_AGE_MS) return 'too_fast';
  if (age > BOT_MAX_AGE_MS) return 'expired';
  return 'ok';
}

export function rateLimitAllows(input: {
  hits: number[];
  now: number;
  limit?: number;
  windowMs?: number;
}): { allowed: boolean; hitsInWindow: number } {
  const limit = input.limit ?? AUTH_RATE_LIMIT;
  const windowMs = input.windowMs ?? AUTH_RATE_WINDOW_MS;
  const windowStart = input.now - windowMs;
  const hitsInWindow = input.hits.filter((stamp) => stamp >= windowStart && stamp <= input.now).length;
  return { allowed: hitsInWindow < limit, hitsInWindow };
}

export function suspiciousPattern(input: {
  failuresInWindow: number;
  mfaFailuresInWindow: number;
  newDevicesInWindow: number;
}): 'password_failures' | 'mfa_failures' | 'possible_shared_account' | null {
  if (input.mfaFailuresInWindow >= LOCKOUT_MAX_FAILURES) return 'mfa_failures';
  if (input.failuresInWindow >= LOCKOUT_MAX_FAILURES) return 'password_failures';
  if (input.newDevicesInWindow >= SHARED_ACCOUNT_DEVICE_LIMIT) return 'possible_shared_account';
  return null;
}

export function sanitizeAuditDetails(
  input: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_FIELD.test(key)) continue;
    if (typeof value === 'string') {
      if (value.length > 300) continue;
      out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    }
  }
  return out;
}

export function passwordPolicyMessage(
  reason: PasswordRejectReason,
  locale: 'en' | 'es' = 'en'
): string {
  const es = locale === 'es';
  switch (reason) {
    case 'too_short':
      return es
        ? 'Use al menos 12 caracteres. Una frase larga está bien.'
        : 'Use at least 12 characters. A long passphrase is fine.';
    case 'too_long':
      return es
        ? 'Use 256 caracteres o menos.'
        : 'Use 256 characters or fewer.';
    case 'common':
      return es
        ? 'Esa contraseña es demasiado común. Elija otra frase.'
        : 'That password is too common. Choose a different passphrase.';
    case 'breached':
      return es
        ? 'Esa contraseña apareció en una filtración. Elija otra.'
        : 'That password has appeared in a data breach. Choose a different one.';
    case 'breach_check_unavailable':
      return es
        ? 'No se pudo comprobar la contraseña. Inténtelo de nuevo en un momento.'
        : 'The password check is temporarily unavailable. Try again in a moment.';
    default:
      return es ? 'Elija otra contraseña.' : 'Choose a different password.';
  }
}
