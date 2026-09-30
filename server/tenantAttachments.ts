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
const MAX_BYTES = 12 * 1024 * 1024;

const KINDS = {
  vendorBill: { folder: 'vendorBills', baseName: 'invoice' },
  customerBol: { folder: 'customerBols', baseName: 'bol' }
} as const;

type AttachmentKind = keyof typeof KINDS;

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

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Upload scanned vendor invoices / customer BOLs via Admin SDK (no Storage-rules cross-service lookup). */
export function registerTenantAttachmentRoutes(app: Express): void {
  app.post('/api/tenant-attachment', async (req: Request, res: Response) => {
    try {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Firebase Admin is not configured.' });
        return;
      }

      const uid = await readBearerUid(req);
      const tenantId = String(req.body?.tenantId || '').trim();
      const kind = String(req.body?.kind || '').trim() as AttachmentKind;
      const docId = String(req.body?.docId || '').trim();
      const contentType = String(req.body?.contentType || '').trim();
      const dataBase64 = String(req.body?.dataBase64 || '').trim();

      if (!isSafeSegment(tenantId) || !isSafeSegment(docId) || !KINDS[kind] || !dataBase64) {
        res.status(400).json({ error: 'tenantId, kind, docId, and dataBase64 are required.' });
        return;
      }
      if (contentType !== 'application/pdf' && contentType !== 'image/jpeg') {
        res.status(400).json({ error: 'Only PDF or JPEG files are supported.' });
        return;
      }

      const roles = await getMemberRoles(tenantId, uid);
      if (!roles.length) {
        res.status(403).json({ error: 'Not a member of this nursery.' });
        return;
      }

      const buffer = Buffer.from(dataBase64, 'base64');
      if (!buffer.length) {
        res.status(400).json({ error: 'File is empty.' });
        return;
      }
      if (buffer.length > MAX_BYTES) {
        res.status(400).json({ error: 'File is too large (max 12 MB).' });
        return;
      }

      getAdminDb();
      const { folder, baseName } = KINDS[kind];
      const ext = contentType === 'application/pdf' ? 'pdf' : 'jpg';
      const path = `tenants/${tenantId}/${folder}/${docId}/${baseName}.${ext}`;
      const downloadToken = randomUUID();
      await getStorage()
        .bucket(BUCKET)
        .file(path)
        .save(buffer, {
          metadata: {
            contentType,
            cacheControl: 'private,max-age=31536000',
            metadata: { firebaseStorageDownloadTokens: downloadToken }
          }
        });

      res.json({ url: firebaseDownloadUrl(BUCKET, path, downloadToken), path });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 500;
      res.status(status).json({ error: err?.message || 'Failed to upload file.' });
    }
  });
}
