import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import type { DocumentReference } from 'firebase-admin/firestore';
import {
  getAdminDb,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

/** Mirror of client DEFAULT_CONTAINER_WEIGHTS — keep in sync with src/data/defaultWeights.ts */
const DEFAULT_CONTAINER_WEIGHTS = [
  { id: '#1', name: '#1 / 1-Gallon Pot', label: '#1', weightLbs: 3 },
  { id: '#3', name: '#3 / 3-Gallon Pot', label: '#3', weightLbs: 13 },
  { id: '#5', name: '#5 / 5-Gallon Pot', label: '#5', weightLbs: 25 },
  { id: '#7', name: '#7 / 7-Gallon Pot', label: '#7', weightLbs: 30 },
  { id: '#10', name: '#10 / 10-Gallon Pot', label: '#10', weightLbs: 45 },
  { id: '#15', name: '#15 / 15-Gallon Pot', label: '#15', weightLbs: 60 },
  { id: '#30', name: '#30 / 30-Gallon Pot', label: '#30', weightLbs: 150 },
  { id: '#45', name: '#45 / 45-Gallon Pot', label: '#45', weightLbs: 225 },
  { id: 'B&B', name: 'Balled & Burlapped (B&B)', label: 'B&B', weightLbs: 250 },
  { id: '4 inch', name: '4-inch Pot', label: '4 inch', weightLbs: 0.44 },
  { id: '6 inch', name: '6-inch Pot', label: '6 inch', weightLbs: 2 },
  { id: 'Tray', name: '18 ct flat / Tray', label: 'Tray', weightLbs: 8 },
  { id: 'Other', name: 'Other / Custom Size', label: 'Other', weightLbs: 0 }
];

const ALL_MODULE_IDS = new Set([
  'orders',
  'trucks',
  'customers',
  'inventory',
  'invoicing',
  'reports',
  'tasks',
  'bol',
  'vendors',
  'profit',
  'payments',
  'quickbooks',
  'purchasing'
]);

type AccessRequestStatus = 'pending' | 'approved' | 'declined';

export interface AccessRequestDoc {
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
  approvedByUserId?: string | null;
  declinedAt?: string | null;
  declinedByUserId?: string | null;
}

function httpError(res: Response, err: any) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[platform]', err);
  res.status(status).json({
    error: err?.message || 'Platform request failed.'
  });
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugifyNurseryName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'nursery'}-${suffix}`;
}

function appBaseUrl(req: Request): string {
  const fromEnv =
    process.env.APP_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.VITE_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  // Prefer the public product domain — never use Railway's *.up.railway.app host
  // for Firebase action links (that domain is usually not Auth-allowlisted).
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .trim()
    .toLowerCase();
  if (
    host &&
    !host.includes('railway.app') &&
    !host.includes('localhost') &&
    !host.startsWith('127.0.0.1')
  ) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  return 'https://nurseryos.app';
}

async function generateOwnerPasswordResetLink(email: string, continueUrl: string): Promise<string> {
  try {
    return await admin.auth().generatePasswordResetLink(email, {
      url: `${continueUrl}/`
    });
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    // Domain not allowlisted / unauthorized continue URL — fall back to Firebase default handler.
    if (
      /allowlist|whitelist|unauthorized.domain|unauthorized_continue_uri|invalid.continue/i.test(
        msg
      )
    ) {
      console.warn(
        '[platform] continue URL not allowlisted, generating reset link without custom URL:',
        continueUrl,
        msg
      );
      return await admin.auth().generatePasswordResetLink(email);
    }
    throw err;
  }
}

function platformFromAddress(): string {
  const raw = process.env.RESEND_FROM_EMAIL?.trim();
  if (raw) return raw;
  return 'NurseryOS <onboarding@resend.dev>';
}

async function sendViaResend(params: {
  fromName: string;
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error(
        'Email sending is not configured. Add RESEND_API_KEY (and optionally RESEND_FROM_EMAIL) in Railway.'
      ),
      { status: 503 }
    );
  }

  const safeName = params.fromName.replace(/"/g, '').trim() || 'NurseryOS';
  const platform = platformFromAddress();
  const match = platform.match(/<([^>]+)>/);
  const fromAddress = match?.[1] || (looksLikeEmail(platform) ? platform : 'onboarding@resend.dev');
  const fromHeader = `${safeName} <${fromAddress}>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromHeader,
      to: [params.to],
      reply_to: params.replyTo || undefined,
      subject: params.subject,
      text: params.text,
      html: params.html
    })
  });

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    error?: { message?: string };
  };

  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `Resend error (${res.status})`;
    throw Object.assign(new Error(detail), { status: 502 });
  }

  return data.id || 'sent';
}

async function readBearerUid(req: Request): Promise<string> {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error('Missing Authorization bearer token.'), { status: 401 });
  }
  const decoded = await verifyFirebaseIdToken(match[1]);
  return decoded.uid;
}

async function assertPlatformAdmin(uid: string): Promise<void> {
  const snap = await getAdminDb().doc(`users/${uid}`).get();
  if (!snap.exists || snap.data()?.isPlatformAdmin !== true) {
    throw Object.assign(new Error('Platform admin access required.'), { status: 403 });
  }
}

function withPlatformAdmin(req: Request, res: Response, fn: (uid: string) => Promise<void>) {
  void (async () => {
    try {
      if (!isFirebaseAdminConfigured()) {
        throw Object.assign(
          new Error('Firebase Admin is not configured on the server.'),
          { status: 503 }
        );
      }
      const uid = await readBearerUid(req);
      await assertPlatformAdmin(uid);
      await fn(uid);
    } catch (err: any) {
      httpError(res, err);
    }
  })();
}

function normalizeModules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (ALL_MODULE_IDS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

async function ensureUniqueTenantId(nurseryName: string): Promise<string> {
  const db = getAdminDb();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = slugifyNurseryName(nurseryName);
    const snap = await db.doc(`tenants/${id}`).get();
    if (!snap.exists) return id;
  }
  return `nursery-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

async function resolveOrCreateOwnerUser(params: {
  email: string;
  displayName: string;
}): Promise<{ uid: string; created: boolean }> {
  const email = params.email.trim().toLowerCase();
  try {
    const existing = await admin.auth().getUserByEmail(email);
    if (params.displayName.trim() && !existing.displayName) {
      await admin.auth().updateUser(existing.uid, {
        displayName: params.displayName.trim()
      });
    }
    return { uid: existing.uid, created: false };
  } catch (err: any) {
    if (err?.code !== 'auth/user-not-found') throw err;
  }

  const password = crypto.randomBytes(24).toString('base64url');
  const created = await admin.auth().createUser({
    email,
    password,
    displayName: params.displayName.trim() || undefined,
    emailVerified: false
  });
  return { uid: created.uid, created: true };
}

/** Persist a public access request (called from request-access route). */
export async function createAccessRequestDoc(input: {
  displayName: string;
  nurseryName: string;
  email: string;
  message: string;
  locale: string;
}): Promise<string> {
  const db = getAdminDb();
  const now = new Date().toISOString();
  const ref = db.collection('accessRequests').doc();
  const doc: AccessRequestDoc = {
    displayName: input.displayName,
    nurseryName: input.nurseryName,
    email: input.email.toLowerCase(),
    message: input.message || '',
    locale: input.locale || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
  await ref.set(doc);
  return ref.id;
}

export function registerPlatformRoutes(app: Express) {
  app.get('/api/platform/access-requests', (req, res) => {
    withPlatformAdmin(req, res, async () => {
      const statusFilter = String(req.query.status || 'pending').trim().toLowerCase();
      const snap = await getAdminDb()
        .collection('accessRequests')
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();

      const requests = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as AccessRequestDoc) }))
        .filter((r) => (statusFilter === 'all' ? true : r.status === statusFilter));

      res.json({ requests });
    });
  });

  app.post('/api/platform/access-requests/:id/decline', (req, res) => {
    withPlatformAdmin(req, res, async (uid) => {
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ error: 'Missing request id.' });
        return;
      }
      const ref = getAdminDb().doc(`accessRequests/${id}`);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Access request not found.' });
        return;
      }
      const data = snap.data() as AccessRequestDoc;
      if (data.status !== 'pending') {
        res.status(400).json({ error: `Request is already ${data.status}.` });
        return;
      }
      const now = new Date().toISOString();
      await ref.update({
        status: 'declined',
        declinedAt: now,
        declinedByUserId: uid,
        updatedAt: now
      });
      res.json({ success: true });
    });
  });

  app.post('/api/platform/provision-nursery', (req, res) => {
    withPlatformAdmin(req, res, async (adminUid) => {
      const displayName = String(req.body?.displayName || '').trim();
      const nurseryName = String(req.body?.nurseryName || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const locale = String(req.body?.locale || 'en').trim() || 'en';
      const accessRequestId = String(req.body?.accessRequestId || '').trim();
      const modules = normalizeModules(req.body?.modules);
      const sendWelcome = req.body?.sendWelcomeEmail !== false;

      if (!nurseryName || nurseryName.length > 160) {
        res.status(400).json({ error: 'Please enter a nursery name.' });
        return;
      }
      if (!looksLikeEmail(email) || email.length > 200) {
        res.status(400).json({ error: 'Please enter a valid owner email.' });
        return;
      }
      if (displayName.length > 120) {
        res.status(400).json({ error: 'Owner name is too long.' });
        return;
      }

      getAdminDb(); // ensure admin app initialized for Auth

      let requestRef: DocumentReference | null = null;
      if (accessRequestId) {
        requestRef = getAdminDb().doc(`accessRequests/${accessRequestId}`);
        const requestSnap = await requestRef.get();
        if (!requestSnap.exists) {
          res.status(404).json({ error: 'Access request not found.' });
          return;
        }
        const requestData = requestSnap.data() as AccessRequestDoc;
        if (requestData.status !== 'pending') {
          res.status(400).json({ error: `Request is already ${requestData.status}.` });
          return;
        }
      }

      const { uid: ownerUid, created: userCreated } = await resolveOrCreateOwnerUser({
        email,
        displayName: displayName || nurseryName
      });

      const tenantId = await ensureUniqueTenantId(nurseryName);
      const now = new Date().toISOString();
      const db = getAdminDb();

      const existingProfile = await db.doc(`users/${ownerUid}`).get();
      const prev = existingProfile.exists ? existingProfile.data() || {} : {};

      const batch = db.batch();
      batch.set(db.doc(`tenants/${tenantId}`), {
        name: nurseryName,
        createdAt: now,
        ownerId: ownerUid,
        modules
      });
      batch.set(db.doc(`tenants/${tenantId}/members/${ownerUid}`), {
        userId: ownerUid,
        email,
        role: 'owner',
        roles: ['owner'],
        displayName: displayName || undefined,
        joinedAt: now
      });
      batch.set(
        db.doc(`users/${ownerUid}`),
        {
          uid: ownerUid,
          email,
          displayName: displayName || prev.displayName || undefined,
          activeTenantId: tenantId,
          createdAt: prev.createdAt || now,
          locale: locale === 'es' ? 'es' : prev.locale || 'en',
          ...(prev.isPlatformAdmin === true ? { isPlatformAdmin: true } : {})
        },
        { merge: true }
      );

      for (const cw of DEFAULT_CONTAINER_WEIGHTS) {
        batch.set(db.doc(`tenants/${tenantId}/containerWeights/${cw.id}`), cw);
      }

      if (requestRef) {
        batch.update(requestRef, {
          status: 'approved',
          approvedTenantId: tenantId,
          approvedAt: now,
          approvedByUserId: adminUid,
          updatedAt: now
        });
      }

      await batch.commit();

      let resetLink: string | null = null;
      let welcomeEmailId: string | null = null;
      let welcomeWarning: string | null = null;
      if (sendWelcome) {
        try {
          resetLink = await generateOwnerPasswordResetLink(email, appBaseUrl(req));

          const text = [
            `Hi${displayName ? ` ${displayName}` : ''},`,
            '',
            `Your NurseryOS workspace for ${nurseryName} is ready.`,
            '',
            'Set your password and sign in here:',
            resetLink,
            '',
            'If you did not request access, you can ignore this email.',
            '',
            '— NurseryOS'
          ].join('\n');

          const html = `
          <p>Hi${displayName ? ` ${escapeHtml(displayName)}` : ''},</p>
          <p>Your NurseryOS workspace for <strong>${escapeHtml(nurseryName)}</strong> is ready.</p>
          <p><a href="${escapeHtml(resetLink)}">Set your password and sign in</a></p>
          <p style="color:#64748b;font-size:12px;">If the button does not work, copy this link:<br/>${escapeHtml(resetLink)}</p>
          <p>— NurseryOS</p>
        `;

          welcomeEmailId = await sendViaResend({
            fromName: 'NurseryOS',
            to: email,
            subject: `Your NurseryOS workspace is ready — ${nurseryName}`,
            text,
            html
          });
        } catch (welcomeErr: any) {
          console.error('[platform] nursery created but welcome email failed', welcomeErr);
          welcomeWarning =
            welcomeErr?.message ||
            'Nursery was created, but the welcome / password email failed.';
        }
      }

      res.json({
        success: true,
        tenantId,
        ownerUid,
        userCreated,
        modules,
        welcomeEmailId,
        resetLinkSent: Boolean(resetLink && welcomeEmailId),
        warning: welcomeWarning
      });
    });
  });

  app.post('/api/platform/delete-nursery', (req, res) => {
    withPlatformAdmin(req, res, async () => {
      const tenantId = String(req.body?.tenantId || '').trim();
      const confirmName = String(req.body?.confirmName || '').trim();
      if (!tenantId) {
        res.status(400).json({ error: 'Missing nursery id.' });
        return;
      }

      const db = getAdminDb();
      const tenantRef = db.doc(`tenants/${tenantId}`);
      const tenantSnap = await tenantRef.get();
      if (!tenantSnap.exists) {
        res.status(404).json({ error: 'Nursery not found.' });
        return;
      }

      const tenantName = String(tenantSnap.data()?.name || '').trim();
      if (confirmName && confirmName !== tenantName) {
        res.status(400).json({
          error: `Name does not match. Type "${tenantName}" exactly to delete.`
        });
        return;
      }

      // Clear activeTenantId for any users pointing at this nursery
      const usersSnap = await db.collection('users').where('activeTenantId', '==', tenantId).get();
      if (!usersSnap.empty) {
        let batch = db.batch();
        let ops = 0;
        for (const userDoc of usersSnap.docs) {
          batch.update(userDoc.ref, { activeTenantId: null });
          ops += 1;
          if (ops >= 400) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }
        if (ops > 0) await batch.commit();
      }

      // Remove invite code index docs for this nursery
      const inviteCodesSnap = await db
        .collection('inviteCodes')
        .where('tenantId', '==', tenantId)
        .get();
      if (!inviteCodesSnap.empty) {
        let batch = db.batch();
        let ops = 0;
        for (const codeDoc of inviteCodesSnap.docs) {
          batch.delete(codeDoc.ref);
          ops += 1;
          if (ops >= 400) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }
        if (ops > 0) await batch.commit();
      }

      // Recursive delete of tenant doc + all subcollections
      await db.recursiveDelete(tenantRef);

      res.json({ success: true, tenantId, name: tenantName });
    });
  });
}
