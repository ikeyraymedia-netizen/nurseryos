import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import admin from 'firebase-admin';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  setStrictSessionGuard,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { isMelioSecurityStrict } from './securityFlag';
import { registerPasskeyRoutes } from './passkeys';
import { requestContext } from './requestContext';
import { sendSecurityNotice } from './securityMail';
import {
  createStrictPasswordResetLink,
  GENERIC_RESET_MESSAGE,
  resetTokenDocId
} from './securityReset';
import {
  assessPassword,
  AUTH_RATE_WINDOW_MS,
  botChallengeStatus,
  decideLockout,
  IDLE_TIMEOUT_MS,
  LOCKOUT_WINDOW_MS,
  MAX_SESSION_MS,
  mfaIsFresh,
  passwordPolicyMessage,
  rateLimitAllows,
  recordFailure,
  resetTokenStatus,
  sanitizeAuditDetails,
  sessionFreshness,
  SHARED_ACCOUNT_DEVICE_LIMIT,
  SHARED_ACCOUNT_WINDOW_MS,
  sha256Hex,
  suspiciousPattern
} from '../src/lib/securityPolicy';

const SESSION_COOKIE = 'nursery_sid';
const ACTIVITY_WRITE_MS = 60_000;
const ticketKey = crypto.randomBytes(32);
const hitsByKey = new Map<string, number[]>();

type Purpose = 'login' | 'signup' | 'reset';

function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

function sendErr(res: Response, err: unknown) {
  const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : 'Request failed.';
  if (status >= 500) console.error('[security]', message);
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

function clientIpHash(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

function noteHit(key: string, now: number): { allowed: boolean } {
  const prev = hitsByKey.get(key) || [];
  const decision = rateLimitAllows({ hits: prev, now });
  const windowStart = now - AUTH_RATE_WINDOW_MS;
  hitsByKey.set(key, [...prev.filter((stamp) => stamp >= windowStart), now]);
  if (hitsByKey.size > 5000) {
    const oldest = hitsByKey.keys().next().value;
    if (oldest) hitsByKey.delete(oldest);
  }
  return decision;
}

function appUrl(req: Request): string {
  const fromEnv = process.env.APP_URL?.trim() || process.env.PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!host) return 'https://nurseryos.app';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

function cookieSecure(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function writeSessionCookie(req: Request, res: Response, rawId: string | null) {
  const parts = [
    rawId ? `${SESSION_COOKIE}=${encodeURIComponent(rawId)}` : `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    rawId ? `Max-Age=${Math.floor(MAX_SESSION_MS / 1000)}` : 'Max-Age=0'
  ];
  // Secure on HTTPS (Railway). Local HTTP omits it so the cookie is stored in dev.
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function requireStrict() {
  if (!isMelioSecurityStrict()) {
    throw httpError(404, 'Security strict mode is off.', 'strict_off');
  }
  if (!isFirebaseAdminConfigured()) {
    throw httpError(503, 'Security checks are not available on the server.', 'admin_unavailable');
  }
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function purposeOf(value: unknown): Purpose {
  const purpose = String(value || '');
  if (purpose === 'login' || purpose === 'signup' || purpose === 'reset') return purpose;
  throw httpError(400, 'Unsupported request.', 'purpose');
}

function issueTicket(email: string, purpose: Purpose): string {
  const payload = Buffer.from(
    JSON.stringify({ email, purpose, exp: Date.now() + 5 * 60 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', ticketKey).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readTicket(token: string): { email: string; purpose: string } | null {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', ticketKey).update(payload).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
      purpose?: string;
      exp?: number;
    };
    if (!parsed.email || !parsed.purpose || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return { email: parsed.email, purpose: parsed.purpose };
  } catch {
    return null;
  }
}

async function lookupHibpRange(prefix: string): Promise<string | null> {
  // Prefix only — the password never leaves the process, and HIBP never sees the full hash.
  if (!/^[0-9A-F]{5}$/.test(prefix)) return null;
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        'Add-Padding': 'true',
        'User-Agent': 'NurseryOS-password-check'
      }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function audit(action: string, details: Record<string, unknown>) {
  const row = {
    action,
    at: new Date().toISOString(),
    ...sanitizeAuditDetails(details)
  };
  console.info(JSON.stringify({ type: 'security_audit', ...row }));
  try {
    await getAdminDb().collection('securityAudit').add(row);
  } catch (err) {
    console.error('[security] audit write failed', err instanceof Error ? err.message : '');
  }
}

async function raiseAlert(input: {
  kind: string;
  summary: string;
  uid?: string | null;
  email?: string | null;
  tenantId?: string | null;
}) {
  const at = new Date().toISOString();
  console.info(
    JSON.stringify({
      type: 'security_alert',
      kind: input.kind,
      uid: input.uid || null,
      at
    })
  );
  try {
    await getAdminDb().collection('securityAlerts').add({
      kind: input.kind,
      summary: input.summary,
      uid: input.uid || null,
      email: input.email || null,
      tenantId: input.tenantId || null,
      at
    });
  } catch (err) {
    console.error('[security] alert write failed', err instanceof Error ? err.message : '');
  }
  const text = `${input.summary}\n\nIf this was not you, contact your nursery owner.`;
  if (input.email) {
    await sendSecurityNotice(input.email, 'NurseryOS security alert', text);
  }
  if (input.tenantId) {
    try {
      const members = await getAdminDb().collection(`tenants/${input.tenantId}/members`).get();
      for (const doc of members.docs) {
        const data = doc.data();
        const roles: string[] = Array.isArray(data.roles) && data.roles.length ? data.roles.map(String) : data.role ? [String(data.role)] : [];
        const email = String(data.email || '').trim();
        if (email && roles.includes('owner') && email.toLowerCase() !== String(input.email || '').toLowerCase()) {
          await sendSecurityNotice(email, 'NurseryOS security alert', text);
        }
      }
    } catch (err) {
      console.error('[security] owner alert failed', err instanceof Error ? err.message : '');
    }
  }
}

async function profileForUid(uid: string): Promise<{ email: string; tenantId: string; platformAdmin: boolean }> {
  const snap = await getAdminDb().doc(`users/${uid}`).get();
  const data = snap.data() || {};
  return {
    email: String(data.email || ''),
    tenantId: String(data.activeTenantId || ''),
    platformAdmin: data.isPlatformAdmin === true
  };
}

async function assertNurseryAccess(uid: string) {
  const profile = await profileForUid(uid);
  if (profile.platformAdmin) return;
  if (!profile.tenantId) throw httpError(403, 'No nursery access.', 'no_access');
  const roles = await getMemberRoles(profile.tenantId, uid);
  if (!roles.length) throw httpError(403, 'No nursery access.', 'no_access');
}

async function sessionDocId(rawId: string): Promise<string> {
  return (await sha256Hex(rawId)).toLowerCase();
}

async function assertActiveSession(req: Request, uid: string) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) throw httpError(401, 'Sign in again.', 'session_required');
  const ref = getAdminDb().doc(`users/${uid}/securitySessions/${await sessionDocId(raw)}`);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(401, 'Sign in again.', 'session_revoked');
  const data = snap.data() || {};
  if (data.revokedAt) throw httpError(401, 'Sign in again.', 'session_revoked');
  if (String(data.uid || '') !== uid) throw httpError(401, 'Sign in again.', 'session_revoked');
  const now = Date.now();
  const createdAt = Number(data.createdAt || 0);
  const lastActivityAt = Number(data.lastActivityAt || 0);
  const freshness = sessionFreshness({ createdAt, lastActivityAt, now });
  if (freshness !== 'ok') {
    await ref.delete().catch(() => undefined);
    if (freshness === 'idle') throw httpError(401, 'Signed out after 1 hour of inactivity.', 'session_idle');
    throw httpError(401, 'Session ended. Sign in again.', 'session_expired');
  }
  if (now - lastActivityAt >= ACTIVITY_WRITE_MS) {
    await ref.set({ lastActivityAt: now }, { merge: true });
  }
}

async function bearerToken(req: Request, checkRevoked: boolean): Promise<admin.auth.DecodedIdToken> {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, 'Sign in required.', 'auth_required');
  getAdminDb();
  try {
    return await admin.auth().verifyIdToken(match[1], checkRevoked);
  } catch {
    throw httpError(401, 'Sign in again.', 'auth_required');
  }
}

async function requireSessionUser(req: Request): Promise<admin.auth.DecodedIdToken> {
  requireStrict();
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, 'Sign in required.', 'auth_required');
  try {
    return await verifyFirebaseIdToken(match[1]);
  } catch (err) {
    if (typeof (err as { status?: number }).status === 'number') throw err;
    throw httpError(401, 'Sign in again.', 'auth_required');
  }
}

async function openSession(req: Request, res: Response, uid: string, rotate: boolean) {
  const db = getAdminDb();
  const now = Date.now();
  const existing = readCookie(req, SESSION_COOKIE);
  if (!rotate && existing) {
    const ref = db.doc(`users/${uid}/securitySessions/${await sessionDocId(existing)}`);
    const snap = await ref.get();
    if (snap.exists && !snap.data()?.revokedAt && String(snap.data()?.uid || '') === uid) {
      const createdAt = Number(snap.data()?.createdAt || now);
      const lastActivityAt = Number(snap.data()?.lastActivityAt || now);
      const freshness = sessionFreshness({ createdAt, lastActivityAt, now });
      if (freshness === 'ok') {
        await ref.set({ lastActivityAt: now }, { merge: true });
        return { createdAt, expiresAt: createdAt + MAX_SESSION_MS, lastActivityAt: now };
      }
    }
  }
  if (existing) {
    await db.doc(`users/${uid}/securitySessions/${await sessionDocId(existing)}`).delete().catch(() => undefined);
  }
  const rawId = crypto.randomBytes(32).toString('base64url');
  await db.doc(`users/${uid}/securitySessions/${await sessionDocId(rawId)}`).set({
    uid,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + MAX_SESSION_MS,
    revokedAt: null,
    ipHash: clientIpHash(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 160) || null
  });
  writeSessionCookie(req, res, rawId);
  return { createdAt: now, expiresAt: now + MAX_SESSION_MS, lastActivityAt: now };
}

async function revokeAllAccess(uid: string) {
  getAdminDb();
  await admin.auth().revokeRefreshTokens(uid);
  const db = getAdminDb();
  const sessions = await db.collection(`users/${uid}/securitySessions`).get();
  const batch = db.batch();
  sessions.docs.forEach((doc) => batch.delete(doc.ref));
  batch.set(db.doc(`users/${uid}`), { fcmTokens: admin.firestore.FieldValue.delete() }, { merge: true });
  await batch.commit();
}

async function accountContext(email: string): Promise<{ uid: string | null; tenantId: string | null; email: string }> {
  const normalized = email.trim().toLowerCase();
  try {
    const user = await admin.auth().getUserByEmail(normalized);
    const profile = await profileForUid(user.uid);
    return { uid: user.uid, tenantId: profile.tenantId || null, email: user.email || normalized };
  } catch {
    return { uid: null, tenantId: null, email: normalized };
  }
}

async function lockoutRef(email: string) {
  const id = (await sha256Hex(email.trim().toLowerCase())).toLowerCase();
  return getAdminDb().doc(`securityLockouts/${id}`);
}

async function readFailures(email: string): Promise<{ failures: number[]; lockedUntil: number | null }> {
  const snap = await (await lockoutRef(email)).get();
  const data = snap.data() || {};
  const passwordFailures = Array.isArray(data.failures) ? data.failures.map(Number) : [];
  const mfaFailures = Array.isArray(data.mfaFailures) ? data.mfaFailures.map(Number) : [];
  return {
    failures: [...passwordFailures, ...mfaFailures],
    lockedUntil: typeof data.lockedUntil === 'number' ? data.lockedUntil : null
  };
}

async function consumeChallenge(rawId: string, purpose: Purpose, honeypot: string) {
  const ref = getAdminDb().doc(`securityChallenges/${(await sha256Hex(rawId)).toLowerCase()}`);
  const status = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'used' as const;
    const data = snap.data() || {};
    if (String(data.purpose || '') !== purpose) return 'used' as const;
    const next = botChallengeStatus({
      honeypot,
      createdAt: Number(data.createdAt || 0),
      now: Date.now(),
      used: data.usedAt != null
    });
    if (next === 'ok' || next === 'bot' || next === 'used' || next === 'expired') {
      tx.delete(ref);
    }
    return next;
  });
  if (status !== 'ok') {
    const message =
      status === 'too_fast'
        ? 'Please wait a moment and try again.'
        : 'Please reload the page and try again.';
    throw httpError(400, message, status === 'bot' ? 'bot' : 'challenge');
  }
}

function assertCallerIsAdmin(roles: Awaited<ReturnType<typeof getMemberRoles>>) {
  if (!hasAnyRole(roles, ['owner', 'admin'])) {
    throw httpError(403, 'Only an owner or admin can do that.', 'forbidden');
  }
}

export function registerSecurityRoutes(app: Express): void {
  // When the flag is on, every bearer-token route also needs a live session
  // and a current nursery membership (or platform-admin). Flag off: this is not called.
  setStrictSessionGuard(async (decoded) => {
    if (!isMelioSecurityStrict()) return;
    const req = requestContext.getStore()?.req;
    if (!req) throw httpError(401, 'Sign in again.', 'session_required');
    await assertActiveSession(req, decoded.uid);
    await assertNurseryAccess(decoded.uid);
  });

  app.get('/api/security/config', (_req, res) => {
    res.json({ strict: isMelioSecurityStrict() });
  });

  app.post('/api/security/password-check', async (req, res) => {
    try {
      requireStrict();
      const password = String(req.body?.password || '');
      const assessed = await assessPassword(password, lookupHibpRange);
      if (!assessed.ok && assessed.reason) {
        throw httpError(400, passwordPolicyMessage(assessed.reason), assessed.reason);
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  registerPasskeyRoutes(
    app,
    async (req) => {
      const decoded = await requireSessionUser(req);
      return { uid: decoded.uid, email: decoded.email || '' };
    },
    sendErr
  );

  app.post('/api/security/challenge', async (req, res) => {
    try {
      requireStrict();
      const purpose = purposeOf(req.body?.purpose);
      const now = Date.now();
      if (!noteHit(`challenge:${clientIpHash(req)}`, now).allowed) {
        throw httpError(429, 'Too many attempts. Try again later.', 'rate_limited');
      }
      const rawId = crypto.randomBytes(32).toString('base64url');
      await getAdminDb()
        .doc(`securityChallenges/${(await sha256Hex(rawId)).toLowerCase()}`)
        .set({ purpose, createdAt: now, usedAt: null });
      res.json({ challengeId: rawId });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/login-gate', async (req, res) => {
    try {
      requireStrict();
      const purpose = purposeOf(req.body?.purpose);
      const email = String(req.body?.email || '').trim().toLowerCase();
      const honeypot = String(req.body?.fax_number || req.body?.company || '');
      const challengeId = String(req.body?.challengeId || '');
      if (!looksLikeEmail(email) || email.length > 200) {
        throw httpError(400, 'Enter a valid email address.', 'email');
      }
      const now = Date.now();
      if (!noteHit(`gate:${clientIpHash(req)}`, now).allowed) {
        throw httpError(429, 'Too many attempts. Try again later.', 'rate_limited');
      }
      await consumeChallenge(challengeId, purpose, honeypot);
      const state = await readFailures(email);
      const decision = decideLockout({
        failureTimestamps: state.failures,
        now,
        lockedUntil: state.lockedUntil
      });
      if (decision.locked) {
        await audit('login_locked', { email, purpose, ipHash: clientIpHash(req) });
        throw httpError(429, 'Too many attempts. Try again later.', 'locked');
      }
      res.json({ allowed: true, ticket: issueTicket(email, purpose) });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/login-result', async (req, res) => {
    try {
      requireStrict();
      const outcome = String(req.body?.outcome || '');
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!looksLikeEmail(email)) throw httpError(400, 'Enter a valid email address.', 'email');
      if (!['success', 'failure', 'mfa_success', 'mfa_failure'].includes(outcome)) {
        throw httpError(400, 'Unsupported request.', 'outcome');
      }
      const now = Date.now();
      if (!noteHit(`result:${clientIpHash(req)}`, now).allowed) {
        throw httpError(429, 'Too many attempts. Try again later.', 'rate_limited');
      }
      const ticket = readTicket(String(req.body?.ticket || ''));
      const bearer = await bearerToken(req, true).catch(() => null);
      const failure = outcome === 'failure' || outcome === 'mfa_failure';
      if (failure) {
        if (!ticket || ticket.email !== email) throw httpError(400, 'Please try again.', 'ticket');
      } else if ((!ticket || ticket.email !== email) && !bearer) {
        throw httpError(400, 'Please try again.', 'ticket');
      }

      const ref = await lockoutRef(email);
      const account = await accountContext(email);
      let pattern: ReturnType<typeof suspiciousPattern> = null;
      await getAdminDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data() || {};
        const failures = Array.isArray(data.failures) ? data.failures.map(Number) : [];
        const mfaFailures = Array.isArray(data.mfaFailures) ? data.mfaFailures.map(Number) : [];
        if (!failure) {
          tx.set(ref, { email, failures: [], mfaFailures: [], lockedUntil: null, updatedAt: now }, { merge: true });
          return;
        }
        const nextFailures = outcome === 'failure' ? recordFailure(failures, now) : failures;
        const nextMfa = outcome === 'mfa_failure' ? recordFailure(mfaFailures, now) : mfaFailures;
        const decision = decideLockout({
          failureTimestamps: [...nextFailures, ...nextMfa],
          now,
          lockedUntil: typeof data.lockedUntil === 'number' ? data.lockedUntil : null
        });
        tx.set(
          ref,
          {
            email,
            failures: nextFailures,
            mfaFailures: nextMfa,
            lockedUntil: decision.locked ? decision.lockedUntil : null,
            updatedAt: now
          },
          { merge: true }
        );
        pattern = suspiciousPattern({
          failuresInWindow: nextFailures.filter((stamp) => stamp >= now - LOCKOUT_WINDOW_MS).length,
          mfaFailuresInWindow: nextMfa.filter((stamp) => stamp >= now - LOCKOUT_WINDOW_MS).length,
          newDevicesInWindow: 0
        });
      });

      await audit(failure ? 'login_failure' : 'login_success', {
        email,
        outcome,
        uid: bearer?.uid || account.uid,
        ipHash: clientIpHash(req)
      });
      if (pattern) {
        await raiseAlert({
          kind: pattern,
          summary:
            pattern === 'mfa_failures'
              ? 'Several authenticator codes failed for a NurseryOS sign-in.'
              : 'Several NurseryOS sign-in attempts failed.',
          uid: account.uid,
          email: account.uid ? account.email : null,
          tenantId: account.tenantId
        });
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/session', async (req, res) => {
    try {
      requireStrict();
      const decoded = await bearerToken(req, true);
      const rotate = req.body?.rotate === true;
      const session = await openSession(req, res, decoded.uid, rotate);
      if (rotate) {
        await audit('session_started', { uid: decoded.uid, ipHash: clientIpHash(req) });
      }
      res.json({ ok: true, ...session });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/security/session', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const raw = readCookie(req, SESSION_COOKIE);
      const snap = await getAdminDb()
        .doc(`users/${decoded.uid}/securitySessions/${await sessionDocId(raw || '')}`)
        .get();
      const createdAt = Number(snap.data()?.createdAt || Date.now());
      res.json({
        ok: true,
        createdAt,
        expiresAt: createdAt + MAX_SESSION_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/logout', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const raw = readCookie(req, SESSION_COOKIE);
      if (raw) {
        await getAdminDb()
          .doc(`users/${decoded.uid}/securitySessions/${await sessionDocId(raw)}`)
          .delete()
          .catch(() => undefined);
      }
      writeSessionCookie(req, res, null);
      await audit('logout', { uid: decoded.uid });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/logout-all', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      await revokeAllAccess(decoded.uid);
      writeSessionCookie(req, res, null);
      await audit('logout_all', { uid: decoded.uid });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/mfa-ok', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const deviceId = String(req.body?.deviceId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) {
        throw httpError(400, 'Unknown device.', 'device');
      }
      const now = Date.now();
      const ref = getAdminDb().doc(`users/${decoded.uid}`);
      const snap = await ref.get();
      const existing = Array.isArray(snap.data()?.securityDevices) ? snap.data()?.securityDevices : [];
      const devices = existing
        .map((row: { id?: string; firstSeenAt?: number }) => ({
          id: String(row?.id || ''),
          firstSeenAt: Number(row?.firstSeenAt || 0)
        }))
        .filter((row: { id: string }) => row.id);
      const known = devices.some((row: { id: string }) => row.id === deviceId);
      if (!known) devices.push({ id: deviceId, firstSeenAt: now });
      const trimmed = devices.slice(-20);
      await ref.set(
        { securityLastMfaAt: now, securityDevices: trimmed },
        { merge: true }
      );
      const freshDevices = trimmed.filter(
        (row: { firstSeenAt: number }) => now - row.firstSeenAt <= SHARED_ACCOUNT_WINDOW_MS
      ).length;
      await audit('mfa_success', { uid: decoded.uid, deviceKnown: known, enrolled: req.body?.enrolled === true });
      if (!known && freshDevices >= SHARED_ACCOUNT_DEVICE_LIMIT) {
        const profile = await profileForUid(decoded.uid);
        await raiseAlert({
          kind: 'possible_shared_account',
          summary: 'This NurseryOS login was used from several new devices in one day. Each person should have their own login.',
          uid: decoded.uid,
          email: profile.email || decoded.email || null,
          tenantId: profile.tenantId || null
        });
      }
      res.json({ ok: true, lastMfaAt: now });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/security/mfa-status', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const deviceId = String(req.query.deviceId || '');
      const snap = await getAdminDb().doc(`users/${decoded.uid}`).get();
      const data = snap.data() || {};
      const lastMfaAt = typeof data.securityLastMfaAt === 'number' ? data.securityLastMfaAt : null;
      const devices = Array.isArray(data.securityDevices) ? data.securityDevices : [];
      const deviceKnown = devices.some((row: { id?: string }) => row?.id === deviceId);
      res.json({ lastMfaAt, deviceKnown, fresh: mfaIsFresh(lastMfaAt, Date.now()) });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/password-reset', async (req, res) => {
    const started = Date.now();
    try {
      requireStrict();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const honeypot = String(req.body?.fax_number || '');
      const challengeId = String(req.body?.challengeId || '');
      if (!looksLikeEmail(email) || email.length > 200) {
        throw httpError(400, 'Enter a valid email address.', 'email');
      }
      if (!noteHit(`reset:${clientIpHash(req)}`, Date.now()).allowed) {
        throw httpError(429, 'Too many attempts. Try again later.', 'rate_limited');
      }
      await consumeChallenge(challengeId, 'reset', honeypot);
      try {
        const issued = await createStrictPasswordResetLink(email, appUrl(req));
        await sendSecurityNotice(
          email,
          'Reset your NurseryOS password',
          `Use this link to choose a new NurseryOS password. It expires in 15 minutes and works once.\n\n${issued.url}\n\nIf you did not ask for this, you can ignore this email.`
        );
        await audit('password_reset_requested', { email, uid: issued.uid, ipHash: clientIpHash(req) });
      } catch {
        await audit('password_reset_requested', { email, knownAccount: false, ipHash: clientIpHash(req) });
      }
      const wait = 400 - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      res.json({ ok: true, message: GENERIC_RESET_MESSAGE });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/password-reset/complete', async (req, res) => {
    try {
      requireStrict();
      const rawToken = String(req.body?.token || '');
      const password = String(req.body?.password || '');
      const honeypot = String(req.body?.fax_number || '');
      if (honeypot.trim()) throw httpError(400, 'This reset link is not valid.', 'bot');
      if (!noteHit(`reset-complete:${clientIpHash(req)}`, Date.now()).allowed) {
        throw httpError(429, 'Too many attempts. Try again later.', 'rate_limited');
      }
      if (!rawToken || rawToken.length > 200) throw httpError(400, 'This reset link is not valid.', 'reset');
      const assessed = await assessPassword(password, lookupHibpRange);
      if (!assessed.ok && assessed.reason) {
        throw httpError(400, passwordPolicyMessage(assessed.reason), assessed.reason);
      }
      const ref = getAdminDb().doc(`securityResetTokens/${await resetTokenDocId(rawToken)}`);
      const now = Date.now();
      let uid = '';
      let email = '';
      await getAdminDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? (snap.data() as { expiresAt: number; usedAt: number | null; uid?: string; email?: string }) : null;
        const status = resetTokenStatus(
          data ? { expiresAt: Number(data.expiresAt), usedAt: data.usedAt == null ? null : Number(data.usedAt) } : null,
          now
        );
        if (status !== 'ok' || !data?.uid) {
          throw httpError(400, 'This reset link is not valid anymore. Request a new one.', 'reset');
        }
        uid = String(data.uid);
        email = String(data.email || '');
        tx.set(ref, { usedAt: now }, { merge: true });
      });
      await admin.auth().updateUser(uid, { password });
      await revokeAllAccess(uid);
      if (email) {
        await sendSecurityNotice(
          email,
          'Your NurseryOS password was reset',
          'Your NurseryOS password was changed and every session was signed out. Sign in again with your authenticator app. If this was not you, contact your nursery owner.'
        );
      }
      await audit('password_reset_completed', { uid, email, ipHash: clientIpHash(req) });
      res.json({ ok: true, signInAgain: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/credential-changed', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const kind = String(req.body?.kind || '');
      if (kind !== 'password') throw httpError(400, 'Unsupported request.', 'kind');
      const profile = await profileForUid(decoded.uid);
      if (!mfaIsFresh(await lastMfaAt(decoded.uid), Date.now())) {
        throw httpError(403, 'Confirm your authenticator app, then try again.', 'mfa_fresh');
      }
      await revokeAllAccess(decoded.uid);
      writeSessionCookie(req, res, null);
      const email = profile.email || decoded.email || '';
      if (email) {
        await sendSecurityNotice(
          email,
          'Your NurseryOS password was changed',
          'Your NurseryOS password was changed and every session was signed out. Sign in again with your authenticator app. If this was not you, contact your nursery owner.'
        );
      }
      await audit('password_changed', { uid: decoded.uid, email });
      res.json({ ok: true, signInAgain: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/contact', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      if (!mfaIsFresh(await lastMfaAt(decoded.uid), Date.now())) {
        throw httpError(403, 'Confirm your authenticator app, then try again.', 'mfa_fresh');
      }
      const nextEmail = String(req.body?.email || '').trim().toLowerCase();
      const nextPhone = String(req.body?.phone || '').trim();
      if (!nextEmail && !nextPhone) throw httpError(400, 'Nothing to change.', 'contact');
      const profile = await profileForUid(decoded.uid);
      const previousEmail = (profile.email || decoded.email || '').toLowerCase();
      if (nextEmail) {
        if (!looksLikeEmail(nextEmail) || nextEmail.length > 200) {
          throw httpError(400, 'Enter a valid email address.', 'email');
        }
        await admin.auth().updateUser(decoded.uid, { email: nextEmail, emailVerified: false });
        await getAdminDb().doc(`users/${decoded.uid}`).set({ email: nextEmail }, { merge: true });
        if (profile.tenantId) {
          const member = getAdminDb().doc(`tenants/${profile.tenantId}/members/${decoded.uid}`);
          const memberSnap = await member.get();
          if (memberSnap.exists) await member.set({ email: nextEmail }, { merge: true });
        }
        const notice =
          'Your NurseryOS sign-in email was changed. If this was not you, contact your nursery owner right away.';
        if (previousEmail) await sendSecurityNotice(previousEmail, 'Your NurseryOS email was changed', notice);
        if (nextEmail !== previousEmail) await sendSecurityNotice(nextEmail, 'Your NurseryOS email was changed', notice);
        await audit('contact_changed', { uid: decoded.uid, field: 'email', previousEmail, email: nextEmail });
      }
      if (nextPhone) {
        if (!/^\+[1-9]\d{7,14}$/.test(nextPhone)) {
          throw httpError(400, 'Enter a phone number like +15551234567.', 'phone');
        }
        await admin.auth().updateUser(decoded.uid, { phoneNumber: nextPhone });
        const notice =
          'The phone number on your NurseryOS login was changed. If this was not you, contact your nursery owner right away.';
        const dest = nextEmail || previousEmail;
        if (dest) await sendSecurityNotice(dest, 'Your NurseryOS phone number was changed', notice);
        await audit('contact_changed', { uid: decoded.uid, field: 'phone' });
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/revoke-member', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const tenantId = String(req.body?.tenantId || '').trim();
      const memberUserId = String(req.body?.memberUserId || '').trim();
      if (!tenantId || !memberUserId) throw httpError(400, 'Missing team member.', 'member');
      if (memberUserId === decoded.uid) throw httpError(400, 'You cannot remove your own login.', 'member');
      assertCallerIsAdmin(await getMemberRoles(tenantId, decoded.uid));
      const targetRoles = await getMemberRoles(tenantId, memberUserId);
      if (!targetRoles.length) throw httpError(404, 'Team member not found.', 'member');
      if (hasAnyRole(targetRoles, ['owner'])) throw httpError(400, 'The owner cannot be removed.', 'member');
      const target = await getAdminDb().doc(`users/${memberUserId}`).get();
      const email = String(target.data()?.email || '');
      await revokeAllAccess(memberUserId);
      if (email) {
        await sendSecurityNotice(
          email,
          'Your NurseryOS access was removed',
          'Your access to this NurseryOS workspace was removed and your sessions were signed out.'
        );
      }
      await audit('access_revoked', { uid: decoded.uid, memberUserId, tenantId, email });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/permission-changed', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const tenantId = String(req.body?.tenantId || '').trim();
      const memberUserId = String(req.body?.memberUserId || '').trim();
      const roles = Array.isArray(req.body?.roles) ? req.body.roles.map(String).slice(0, 12) : [];
      if (!tenantId || !memberUserId || !roles.length) throw httpError(400, 'Missing role change.', 'roles');
      assertCallerIsAdmin(await getMemberRoles(tenantId, decoded.uid));
      await audit('permission_changed', {
        uid: decoded.uid,
        memberUserId,
        tenantId,
        roles: roles.join(',')
      });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/mfa-reset', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      if (!mfaIsFresh(await lastMfaAt(decoded.uid), Date.now())) {
        throw httpError(403, 'Confirm your authenticator app, then try again.', 'mfa_fresh');
      }
      const tenantId = String(req.body?.tenantId || '').trim();
      const memberUserId = String(req.body?.memberUserId || '').trim();
      if (!tenantId || !memberUserId) throw httpError(400, 'Missing team member.', 'member');
      if (memberUserId === decoded.uid) {
        throw httpError(403, 'You cannot turn off your own authenticator.', 'mfa_self');
      }
      assertCallerIsAdmin(await getMemberRoles(tenantId, decoded.uid));
      const targetRoles = await getMemberRoles(tenantId, memberUserId);
      if (!targetRoles.length) throw httpError(404, 'Team member not found.', 'member');
      await admin.auth().updateUser(memberUserId, { multiFactor: { enrolledFactors: null } });
      await getAdminDb().doc(`users/${memberUserId}`).set(
        { securityLastMfaAt: null, securityDevices: [] },
        { merge: true }
      );
      await revokeAllAccess(memberUserId);
      const target = await getAdminDb().doc(`users/${memberUserId}`).get();
      const email = String(target.data()?.email || '');
      if (email) {
        await sendSecurityNotice(
          email,
          'Your NurseryOS authenticator was reset',
          'A nursery admin reset your authenticator. Your sessions were signed out. Sign in and set up an authenticator app again. If this was not you, contact your nursery owner.'
        );
      }
      await audit('mfa_reset', { uid: decoded.uid, memberUserId, tenantId, email });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.get('/api/security/alerts', async (req, res) => {
    try {
      const decoded = await requireSessionUser(req);
      const profile = await profileForUid(decoded.uid);
      const own = await getAdminDb()
        .collection('securityAlerts')
        .where('uid', '==', decoded.uid)
        .limit(20)
        .get();
      const rows: Array<{ id: string; kind?: unknown; summary?: unknown; at?: unknown }> = own.docs.map(
        (doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) })
      );
      if (profile.tenantId && hasAnyRole(await getMemberRoles(profile.tenantId, decoded.uid), ['owner', 'admin'])) {
        const team = await getAdminDb()
          .collection('securityAlerts')
          .where('tenantId', '==', profile.tenantId)
          .limit(20)
          .get();
        for (const doc of team.docs) {
          if (!rows.some((row) => row.id === doc.id)) {
            rows.push({ id: doc.id, ...(doc.data() as Record<string, unknown>) });
          }
        }
      }
      rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      res.json({
        alerts: rows.slice(0, 20).map((row) => ({
          id: row.id,
          kind: row.kind || null,
          summary: row.summary || '',
          at: row.at || null
        }))
      });
    } catch (err) {
      sendErr(res, err);
    }
  });
}

async function lastMfaAt(uid: string): Promise<number | null> {
  const snap = await getAdminDb().doc(`users/${uid}`).get();
  const value = snap.data()?.securityLastMfaAt;
  return typeof value === 'number' ? value : null;
}

export { createStrictPasswordResetLink };
