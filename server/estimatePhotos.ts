import { randomUUID } from 'crypto';
import type { Express, Request, Response } from 'express';
import { getStorage } from 'firebase-admin/storage';
import {
  getAdminDb,
  getMemberRoles,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'nurseryos-54c15.firebasestorage.app';
const MAX_BYTES = 5 * 1024 * 1024;

function estimatePhotoPath(tenantId: string, lineId: string): string {
  return `tenants/${tenantId}/estimatePhotos/${lineId}/photo.jpg`;
}

function firebaseDownloadUrl(bucket: string, path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
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

export function registerEstimatePhotoRoutes(app: Express): void {
  app.post('/api/estimate-photo', async (req: Request, res: Response) => {
    try {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Firebase Admin is not configured.' });
        return;
      }

      const uid = await readBearerUid(req);
      const tenantId = String(req.body?.tenantId || '').trim();
      const lineId = String(req.body?.lineId || '').trim();
      const imageBase64 = String(req.body?.imageBase64 || '').trim();

      if (!tenantId || !lineId || !imageBase64) {
        res.status(400).json({ error: 'tenantId, lineId, and imageBase64 are required.' });
        return;
      }

      const roles = await getMemberRoles(tenantId, uid);
      if (!roles.length) {
        res.status(403).json({ error: 'Not a member of this nursery.' });
        return;
      }

      const buffer = Buffer.from(imageBase64, 'base64');
      if (!buffer.length) {
        res.status(400).json({ error: 'Image data is empty.' });
        return;
      }
      if (buffer.length > MAX_BYTES) {
        res.status(400).json({ error: 'Image is too large (max 5 MB).' });
        return;
      }
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        res.status(400).json({ error: 'Only JPEG images are supported.' });
        return;
      }

      getAdminDb();
      const path = estimatePhotoPath(tenantId, lineId);
      const downloadToken = randomUUID();
      const file = getStorage().bucket(BUCKET).file(path);
      await file.save(buffer, {
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'public,max-age=31536000',
          metadata: {
            firebaseStorageDownloadTokens: downloadToken
          }
        }
      });

      res.json({
        photoUrl: firebaseDownloadUrl(BUCKET, path, downloadToken),
        photoPath: path
      });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err?.message || 'Failed to upload estimate photo.' });
    }
  });
}
