import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import {
  getAdminDb,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { sendTenantInvoiceEmail } from './email';
import { sendPushToUserIds } from './pushNotifications';

function appOrigin(override?: string): string {
  const fromClient = String(override || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(fromClient)) return fromClient;
  const raw = process.env.APP_URL?.trim() || 'https://nurseryos.app';
  return raw.replace(/\/+$/, '');
}

function acceptPageUrl(token: string, originOverride?: string): string {
  return `${appOrigin(originOverride)}/e/accept/${encodeURIComponent(token)}`;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

async function assertTenantMember(tenantId: string, uid: string): Promise<void> {
  const snap = await getAdminDb().doc(`tenants/${tenantId}/members/${uid}`).get();
  if (!snap.exists) {
    throw Object.assign(new Error('Not a member of this nursery.'), { status: 403 });
  }
}

function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

type TokenRecord = {
  tenantId: string;
  documentId: string;
  createdAt: string;
};

type EstimateDoc = {
  type?: string;
  documentNumber?: string;
  customerName?: string;
  billToName?: string;
  grandTotal?: number;
  acceptanceStatus?: string;
  acceptToken?: string | null;
  acceptedAt?: string | null;
  acceptedByName?: string | null;
  estimateSentByUserId?: string | null;
  estimateSentByEmail?: string | null;
  estimateSentByName?: string | null;
  customerId?: string;
};

async function loadEstimateByToken(token: string): Promise<{
  token: string;
  record: TokenRecord;
  tenantId: string;
  documentId: string;
  doc: EstimateDoc;
  nurseryName: string;
}> {
  const trimmed = String(token || '').trim();
  if (!trimmed || trimmed.length < 16) {
    throw Object.assign(new Error('Invalid accept link.'), { status: 404 });
  }
  const tokenSnap = await getAdminDb().doc(`estimateAcceptTokens/${trimmed}`).get();
  if (!tokenSnap.exists) {
    throw Object.assign(new Error('This accept link was not found or has expired.'), {
      status: 404
    });
  }
  const record = tokenSnap.data() as TokenRecord;
  const tenantId = String(record.tenantId || '').trim();
  const documentId = String(record.documentId || '').trim();
  if (!tenantId || !documentId) {
    throw Object.assign(new Error('This accept link is invalid.'), { status: 404 });
  }

  const [docSnap, tenantSnap] = await Promise.all([
    getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`).get(),
    getAdminDb().doc(`tenants/${tenantId}`).get()
  ]);
  if (!docSnap.exists) {
    throw Object.assign(new Error('Estimate not found.'), { status: 404 });
  }
  const doc = (docSnap.data() || {}) as EstimateDoc;
  if (doc.type !== 'estimate') {
    throw Object.assign(new Error('This link is not for an estimate.'), { status: 400 });
  }
  if (doc.acceptToken && doc.acceptToken !== trimmed) {
    throw Object.assign(new Error('This accept link is no longer valid.'), { status: 410 });
  }

  const nurseryName =
    String((tenantSnap.data() as { name?: string } | undefined)?.name || '').trim() ||
    'Nursery';

  return { token: trimmed, record, tenantId, documentId, doc, nurseryName };
}

export function registerEstimateAcceptRoutes(app: Express): void {
  /** Auth: create/reuse accept token before emailing an estimate. */
  app.post('/api/estimates/prepare-accept', (req, res) =>
    void (async () => {
      try {
        if (!isFirebaseAdminConfigured()) {
          res.status(503).json({ error: 'Firebase Admin is not configured.' });
          return;
        }
        const uid = await readBearerUid(req);
        const tenantId = String(req.body?.tenantId || '').trim();
        const documentId = String(req.body?.documentId || '').trim();
        const originOverride = String(req.body?.origin || '').trim();
        if (!tenantId || !documentId) {
          res.status(400).json({ error: 'tenantId and documentId are required.' });
          return;
        }
        await assertTenantMember(tenantId, uid);

        const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
        const snap = await docRef.get();
        if (!snap.exists) {
          res.status(404).json({ error: 'Estimate not found. Save it before sending.' });
          return;
        }
        const doc = (snap.data() || {}) as EstimateDoc;
        if (doc.type !== 'estimate') {
          res.status(400).json({ error: 'Only estimates can include an accept link.' });
          return;
        }

        const [userSnap, memberSnap] = await Promise.all([
          getAdminDb().doc(`users/${uid}`).get(),
          getAdminDb().doc(`tenants/${tenantId}/members/${uid}`).get()
        ]);
        const userData = (userSnap.data() || {}) as {
          email?: string;
          displayName?: string;
        };
        const memberData = (memberSnap.data() || {}) as {
          email?: string;
          displayName?: string;
        };
        const senderEmail =
          String(memberData.email || userData.email || '').trim().toLowerCase() || null;
        const senderName =
          String(memberData.displayName || userData.displayName || '').trim() ||
          senderEmail ||
          'Nursery team';

        let token = String(doc.acceptToken || '').trim();
        const now = new Date().toISOString();
        if (!token) {
          token = crypto.randomBytes(24).toString('hex');
        }

        await getAdminDb()
          .doc(`estimateAcceptTokens/${token}`)
          .set(
            {
              tenantId,
              documentId,
              createdAt: now,
              updatedAt: now
            },
            { merge: true }
          );

        const patch: Record<string, unknown> = {
          acceptToken: token,
          estimateSentByUserId: uid,
          estimateSentByEmail: senderEmail,
          estimateSentByName: senderName,
          updatedAt: now
        };
        if (doc.acceptanceStatus !== 'accepted') {
          patch.acceptanceStatus = 'pending';
        }
        await docRef.set(patch, { merge: true });

        res.json({
          ok: true,
          acceptUrl: acceptPageUrl(token, originOverride),
          acceptToken: token,
          acceptanceStatus: doc.acceptanceStatus === 'accepted' ? 'accepted' : 'pending'
        });
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : 500;
        res.status(status).json({ error: err?.message || 'Could not prepare accept link.' });
      }
    })()
  );

  /** Public: estimate summary for the accept page. */
  app.get('/api/public/estimate-accept/:token', (req, res) =>
    void (async () => {
      try {
        if (!isFirebaseAdminConfigured()) {
          res.status(503).json({ error: 'Service unavailable.' });
          return;
        }
        const loaded = await loadEstimateByToken(String(req.params.token || ''));
        res.json({
          ok: true,
          nurseryName: loaded.nurseryName,
          documentNumber: loaded.doc.documentNumber || 'Estimate',
          customerName: loaded.doc.billToName || loaded.doc.customerName || 'Customer',
          grandTotal: Number(loaded.doc.grandTotal) || 0,
          acceptanceStatus:
            loaded.doc.acceptanceStatus === 'accepted' ? 'accepted' : 'pending',
          acceptedAt: loaded.doc.acceptedAt || null,
          acceptedByName: loaded.doc.acceptedByName || null
        });
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : 500;
        res.status(status).json({ error: err?.message || 'Could not load estimate.' });
      }
    })()
  );

  /** Public: customer accepts the estimate. */
  app.post('/api/public/estimate-accept/:token', (req, res) =>
    void (async () => {
      try {
        if (!isFirebaseAdminConfigured()) {
          res.status(503).json({ error: 'Service unavailable.' });
          return;
        }
        const loaded = await loadEstimateByToken(String(req.params.token || ''));
        const acceptedByName = String(req.body?.acceptedByName || '')
          .trim()
          .slice(0, 120);

        if (loaded.doc.acceptanceStatus === 'accepted') {
          res.json({
            ok: true,
            alreadyAccepted: true,
            nurseryName: loaded.nurseryName,
            documentNumber: loaded.doc.documentNumber || 'Estimate',
            acceptedAt: loaded.doc.acceptedAt || null
          });
          return;
        }

        const now = new Date().toISOString();
        await getAdminDb()
          .doc(`tenants/${loaded.tenantId}/documents/${loaded.documentId}`)
          .set(
            {
              acceptanceStatus: 'accepted',
              acceptedAt: now,
              acceptedByName: acceptedByName || null,
              updatedAt: now
            },
            { merge: true }
          );

        const docNumber = loaded.doc.documentNumber || 'Estimate';
        const customerLabel =
          loaded.doc.billToName || loaded.doc.customerName || 'Customer';
        const totalLabel = money(Number(loaded.doc.grandTotal) || 0);
        const who = acceptedByName || customerLabel;

        const senderUid = String(loaded.doc.estimateSentByUserId || '').trim();
        const senderEmail = String(loaded.doc.estimateSentByEmail || '')
          .trim()
          .toLowerCase();

        // Push to original sender (and fall back to sales/office via roles if no uid).
        if (senderUid) {
          void sendPushToUserIds({
            userIds: [senderUid],
            tenantId: loaded.tenantId,
            type: 'estimate_accepted',
            title: `Estimate accepted · ${docNumber}`,
            body: `${who} accepted ${docNumber} (${totalLabel})`,
            url: `/?tab=customers`
          }).catch((err) => console.warn('[estimate-accept] push failed', err));
        }

        if (senderEmail && looksLikeEmail(senderEmail)) {
          const subject = `${docNumber} accepted by ${customerLabel}`;
          const text = [
            `${who} accepted estimate ${docNumber}.`,
            `Customer: ${customerLabel}`,
            `Total: ${totalLabel}`,
            acceptedByName ? `Accepted by: ${acceptedByName}` : '',
            `Accepted at: ${new Date(now).toLocaleString()}`,
            '',
            `Open NurseryOS → Customers to review.`
          ]
            .filter(Boolean)
            .join('\n');
          const html = `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
              <h2 style="color:#0e7490;margin:0 0 12px;">Estimate accepted</h2>
              <p style="margin:0 0 8px;"><strong>${who}</strong> accepted <strong>${docNumber}</strong>.</p>
              <p style="margin:0 0 4px;">Customer: ${customerLabel}</p>
              <p style="margin:0 0 4px;">Total: ${totalLabel}</p>
              ${
                acceptedByName
                  ? `<p style="margin:0 0 4px;">Accepted by: ${acceptedByName}</p>`
                  : ''
              }
              <p style="margin:16px 0 0;font-size:13px;color:#64748b;">Open NurseryOS → Customers to review.</p>
            </div>
          `;
          try {
            await sendTenantInvoiceEmail({
              tenantId: loaded.tenantId,
              to: senderEmail,
              subject,
              text,
              html,
              fromNameOverride: loaded.nurseryName
            });
          } catch (err) {
            console.warn('[estimate-accept] email to sender failed', err);
          }
        }

        res.json({
          ok: true,
          alreadyAccepted: false,
          nurseryName: loaded.nurseryName,
          documentNumber: docNumber,
          acceptedAt: now
        });
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : 500;
        res.status(status).json({ error: err?.message || 'Could not accept estimate.' });
      }
    })()
  );
}
