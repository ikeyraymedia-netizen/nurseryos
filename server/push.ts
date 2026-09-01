import type { Express, Request, Response } from 'express';
import admin from 'firebase-admin';
import {
  getAdminDb,
  getMemberRoles,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { PushEventType, sendTenantPush } from './pushNotifications';

async function readBearerUid(req: Request): Promise<string> {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error('Missing Authorization bearer token.'), { status: 401 });
  }
  const decoded = await verifyFirebaseIdToken(match[1]);
  return decoded.uid;
}

async function assertTenantMember(tenantId: string, uid: string): Promise<void> {
  const roles = await getMemberRoles(tenantId, uid);
  if (!roles.length) {
    throw Object.assign(new Error('Not a member of this nursery.'), { status: 403 });
  }
}

const VALID_TYPES: PushEventType[] = [
  'invoice_paid',
  'order_uploaded',
  'truck_built',
  'task_assigned',
  'plant_added'
];

/** Public VAPID key — safe to expose; also readable at runtime on Railway without a rebuild. */
function readVapidKey(): string {
  return (
    process.env.FIREBASE_VAPID_KEY?.trim() ||
    process.env.VITE_FIREBASE_VAPID_KEY?.trim() ||
    // NurseryOS project default (public key from Firebase Console → Cloud Messaging).
    'BOoizgueN05OYhnk0sbH8TZabP0v6pIf_A4qtqjxV-dJpOU-fI1WUeR42BR2znCGHpqHyP42ncvVau5EPkJ7mhw'
  );
}

export function registerPushRoutes(app: Express): void {
  app.get('/api/push/config', (_req: Request, res: Response) => {
    const vapidKey = readVapidKey();
    res.json({ configured: Boolean(vapidKey), vapidKey: vapidKey || null });
  });

  app.post('/api/push/register-token', async (req: Request, res: Response) => {
    try {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Firebase Admin is not configured.' });
        return;
      }
      const uid = await readBearerUid(req);
      const token = String(req.body?.token || '').trim();
      const deviceId = String(req.body?.deviceId || 'default').trim() || 'default';
      if (!token) {
        res.status(400).json({ error: 'token is required.' });
        return;
      }

      const now = new Date().toISOString();
      await getAdminDb()
        .doc(`users/${uid}`)
        .set(
          {
            fcmTokens: {
              [deviceId]: {
                token,
                updatedAt: now,
                userAgent: String(req.headers['user-agent'] || '').slice(0, 200) || undefined
              }
            }
          },
          { merge: true }
        );

      res.json({ ok: true });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err?.message || 'Failed to register push token.' });
    }
  });

  app.post('/api/push/unregister-token', async (req: Request, res: Response) => {
    try {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Firebase Admin is not configured.' });
        return;
      }
      const uid = await readBearerUid(req);
      const deviceId = String(req.body?.deviceId || 'default').trim() || 'default';

      await getAdminDb()
        .doc(`users/${uid}`)
        .set(
          {
            fcmTokens: {
              [deviceId]: admin.firestore.FieldValue.delete()
            }
          },
          { merge: true }
        );

      res.json({ ok: true });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err?.message || 'Failed to unregister push token.' });
    }
  });

  app.post('/api/push/event', async (req: Request, res: Response) => {
    try {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Firebase Admin is not configured.' });
        return;
      }
      const uid = await readBearerUid(req);
      const tenantId = String(req.body?.tenantId || '').trim();
      const type = String(req.body?.type || '').trim() as PushEventType;
      const title = String(req.body?.title || '').trim();
      const body = String(req.body?.body || '').trim();
      const url = req.body?.url ? String(req.body.url) : undefined;
      const targetUserId = req.body?.targetUserId
        ? String(req.body.targetUserId)
        : undefined;

      if (!tenantId || !VALID_TYPES.includes(type) || !title || !body) {
        res.status(400).json({ error: 'tenantId, type, title, and body are required.' });
        return;
      }
      if (type === 'task_assigned' && !targetUserId) {
        res.status(400).json({ error: 'targetUserId is required for task_assigned.' });
        return;
      }

      await assertTenantMember(tenantId, uid);

      await sendTenantPush({
        tenantId,
        type,
        title,
        body,
        url,
        targetUserId,
        excludeUserId: uid
      });

      res.json({ ok: true });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err?.message || 'Failed to send push notification.' });
    }
  });
}
