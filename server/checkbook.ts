import { createHmac, timingSafeEqual } from 'crypto';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

type CheckbookEnvironment = 'sandbox' | 'production';

interface CheckbookIntegration {
  provider: 'checkbook';
  publishableKey: string;
  secretKey: string;
  /** Webhook signing key from Checkbook developer settings (optional but recommended). */
  webhookKey?: string;
  environment: CheckbookEnvironment;
  connectedAt: string;
  connectedByUserId: string;
  updatedAt: string;
  /** Last 4 of publishable key for UI display only. */
  publishableKeyLast4: string;
}

function checkbookBase(env: CheckbookEnvironment): string {
  return env === 'production' ? 'https://api.checkbook.io' : 'https://demo.checkbook.io';
}

function integrationRef(tenantId: string) {
  return getAdminDb().doc(`tenants/${tenantId}/integrations/checkbook`);
}

async function loadIntegration(tenantId: string): Promise<CheckbookIntegration | null> {
  const snap = await integrationRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() as CheckbookIntegration;
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

async function assertAdminOrOwner(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin'])) {
    throw Object.assign(new Error('Only owners and admins can manage bill pay.'), {
      status: 403
    });
  }
}

async function assertCanPayBills(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office'])) {
    throw Object.assign(new Error('You do not have permission to pay vendor bills.'), {
      status: 403
    });
  }
}

function authHeader(integration: CheckbookIntegration): string {
  return `${integration.publishableKey}:${integration.secretKey}`;
}

async function checkbookFetch(
  integration: CheckbookIntegration,
  path: string,
  init?: RequestInit
): Promise<globalThis.Response> {
  const url = `${checkbookBase(integration.environment)}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(integration),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
}

async function readCheckbookError(res: globalThis.Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { error?: string; message?: string; codes?: unknown };
    if (data?.error) return String(data.error);
    if (data?.message) return String(data.message);
  } catch {
    // non-JSON
  }
  if (text?.trim()) return text.trim().slice(0, 280);
  return `Checkbook request failed (${res.status})`;
}

function last4(value: string): string {
  const cleaned = value.trim();
  return cleaned.length <= 4 ? cleaned : cleaned.slice(-4);
}

function parseSignatureHeader(header: string | undefined): { nonce: string; signature: string } | null {
  if (!header) return null;
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [k, ...rest] = part.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  if (!parts.nonce || !parts.signature) return null;
  return { nonce: parts.nonce, signature: parts.signature };
}

function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookKey: string
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const payload = `${rawBody}${parsed.nonce}`;
  const expected = createHmac('sha256', webhookKey).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function mapPaymentStatus(checkbookStatus: string): 'payment_pending' | 'paid' | 'unpaid' | null {
  const status = checkbookStatus.toUpperCase();
  if (status === 'PAID') return 'paid';
  if (status === 'FAILED' || status === 'VOID' || status === 'EXPIRED' || status === 'REFUNDED') {
    return 'unpaid';
  }
  if (status === 'UNPAID' || status === 'IN_PROCESS' || status === 'MAILED' || status === 'PRINTED') {
    return 'payment_pending';
  }
  return null;
}

async function applyPaymentStatusToBill(params: {
  tenantId: string;
  billId: string;
  paymentId: string;
  checkbookStatus: string;
  depositOption?: string | null;
}) {
  const billRef = getAdminDb().doc(`tenants/${params.tenantId}/vendorBills/${params.billId}`);
  const snap = await billRef.get();
  if (!snap.exists) return;
  const bill = snap.data() as Record<string, unknown>;
  if (bill.checkbookPaymentId && bill.checkbookPaymentId !== params.paymentId) {
    // Different payment — ignore stale webhook
    return;
  }

  const mapped = mapPaymentStatus(params.checkbookStatus);
  if (!mapped) return;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    checkbookPaymentId: params.paymentId,
    checkbookPaymentStatus: params.checkbookStatus,
    updatedAt: now
  };
  if (params.depositOption) {
    patch.checkbookDepositOption = params.depositOption;
  }

  if (mapped === 'paid') {
    patch.status = 'paid';
    patch.paidAt = now;
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.paymentId;
  } else if (mapped === 'unpaid') {
    patch.status = 'unpaid';
    patch.paidAt = null;
    patch.paymentMethod = null;
    patch.paymentReference = null;
    patch.checkbookPaymentError = `Payment ${params.checkbookStatus.toLowerCase()}`;
  } else {
    patch.status = 'payment_pending';
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.paymentId;
  }

  await billRef.set(patch, { merge: true });
}

async function handleAsync(res: ExpressResponse, fn: () => Promise<void>) {
  try {
    if (!isFirebaseAdminConfigured()) {
      res.status(503).json({ error: 'Firebase Admin is not configured on the server.' });
      return;
    }
    await fn();
  } catch (err: unknown) {
    const status = typeof err === 'object' && err && 'status' in err ? Number((err as any).status) : 500;
    const message = err instanceof Error ? err.message : 'Request failed.';
    console.error('[checkbook]', message);
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  }
}

export function registerCheckbookWebhookRoute(app: Express) {
  // Raw body needed for signature verification — register before express.json in server.ts
  app.post(
    '/api/checkbook/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) =>
      void handleAsync(res, async () => {
        const tenantId = String(req.query.tenantId || '').trim();
        if (!tenantId) {
          res.status(400).json({ error: 'tenantId query param required.' });
          return;
        }

        const integration = await loadIntegration(tenantId);
        if (!integration) {
          res.status(404).json({ error: 'Checkbook not connected for this nursery.' });
          return;
        }

        const rawBody =
          typeof req.body === 'string'
            ? req.body
            : Buffer.isBuffer(req.body)
              ? req.body.toString('utf8')
              : JSON.stringify(req.body || {});

        if (integration.webhookKey) {
          const ok = verifyWebhookSignature(
            rawBody,
            String(req.headers.signature || req.headers.Signature || ''),
            integration.webhookKey
          );
          if (!ok) {
            res.status(401).json({ error: 'Invalid Checkbook webhook signature.' });
            return;
          }
        }

        const payload = JSON.parse(rawBody) as {
          id?: string;
          status?: string;
          type?: string;
          deposit_option?: string;
        };

        const paymentId = String(payload.id || '').trim();
        const status = String(payload.status || '').trim();
        if (!paymentId || !status) {
          res.status(400).json({ error: 'Invalid webhook payload.' });
          return;
        }

        const billsSnap = await getAdminDb()
          .collection(`tenants/${tenantId}/vendorBills`)
          .where('checkbookPaymentId', '==', paymentId)
          .limit(1)
          .get();

        const billId = billsSnap.empty ? null : billsSnap.docs[0].id;
        if (!billId) {
          // Acknowledge — payment may not be from NurseryOS
          res.json({ ok: true, matched: false });
          return;
        }

        await applyPaymentStatusToBill({
          tenantId,
          billId,
          paymentId,
          checkbookStatus: status,
          depositOption: payload.deposit_option || null
        });

        res.json({ ok: true, matched: true, billId });
      })
  );
}

export function registerCheckbookRoutes(app: Express) {
  app.get('/api/checkbook/status', (req, res) =>
    void handleAsync(res, async () => {
      const tenantId = String(req.query.tenantId || '').trim();
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      const uid = await readBearerUid(req);
      await assertAdminOrOwner(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      res.json({
        connected: Boolean(integration),
        environment: integration?.environment || null,
        publishableKeyLast4: integration?.publishableKeyLast4 || null,
        hasWebhookKey: Boolean(integration?.webhookKey),
        connectedAt: integration?.connectedAt || null,
        webhookUrl: `${(process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '')}/api/checkbook/webhook?tenantId=${encodeURIComponent(tenantId)}`
      });
    })
  );

  app.post('/api/checkbook/connect', (req, res) =>
    void handleAsync(res, async () => {
      const tenantId = String(req.body?.tenantId || '').trim();
      const publishableKey = String(req.body?.publishableKey || '').trim();
      const secretKey = String(req.body?.secretKey || '').trim();
      const webhookKey = String(req.body?.webhookKey || '').trim();
      const environment =
        String(req.body?.environment || 'sandbox').toLowerCase() === 'production'
          ? 'production'
          : 'sandbox';

      if (!tenantId || !publishableKey || !secretKey) {
        res.status(400).json({ error: 'tenantId, publishableKey, and secretKey are required.' });
        return;
      }

      const uid = await readBearerUid(req);
      await assertAdminOrOwner(tenantId, uid);

      const probe = await fetch(`${checkbookBase(environment)}/v3/check?page=1`, {
        headers: {
          Authorization: `${publishableKey}:${secretKey}`,
          Accept: 'application/json'
        }
      });
      if (!probe.ok && probe.status !== 404) {
        throw Object.assign(
          new Error(
            `Could not verify Checkbook keys (${environment}): ${await readCheckbookError(probe)}`
          ),
          { status: 400 }
        );
      }

      const now = new Date().toISOString();
      const existing = await loadIntegration(tenantId);
      const payload: CheckbookIntegration = {
        provider: 'checkbook',
        publishableKey,
        secretKey,
        webhookKey: webhookKey || existing?.webhookKey || undefined,
        environment,
        connectedAt: existing?.connectedAt || now,
        connectedByUserId: uid,
        updatedAt: now,
        publishableKeyLast4: last4(publishableKey)
      };
      await integrationRef(tenantId).set(payload, { merge: true });

      res.json({
        connected: true,
        environment,
        publishableKeyLast4: payload.publishableKeyLast4,
        hasWebhookKey: Boolean(payload.webhookKey),
        connectedAt: payload.connectedAt,
        webhookUrl: `${(process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '')}/api/checkbook/webhook?tenantId=${encodeURIComponent(tenantId)}`
      });
    })
  );

  app.post('/api/checkbook/disconnect', (req, res) =>
    void handleAsync(res, async () => {
      const tenantId = String(req.body?.tenantId || '').trim();
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      const uid = await readBearerUid(req);
      await assertAdminOrOwner(tenantId, uid);
      await integrationRef(tenantId).delete();
      res.json({ connected: false });
    })
  );

  app.post('/api/checkbook/pay-bill', (req, res) =>
    void handleAsync(res, async () => {
      const tenantId = String(req.body?.tenantId || '').trim();
      const billId = String(req.body?.billId || '').trim();
      const recipientOverride = String(req.body?.recipientEmail || '').trim();

      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }

      const uid = await readBearerUid(req);
      await assertCanPayBills(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration) {
        throw Object.assign(
          new Error('Connect Checkbook in Team settings before paying bills.'),
          { status: 400 }
        );
      }

      const billRef = getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`);
      const billSnap = await billRef.get();
      if (!billSnap.exists) {
        throw Object.assign(new Error('Vendor bill not found.'), { status: 404 });
      }
      const bill = billSnap.data() as {
        status?: string;
        vendorId?: string;
        vendorName?: string;
        billNumber?: string;
        grandTotal?: number;
        checkbookPaymentId?: string;
      };

      if (bill.status === 'paid') {
        throw Object.assign(new Error('This bill is already marked paid.'), { status: 400 });
      }
      if (bill.status === 'payment_pending' && bill.checkbookPaymentId) {
        throw Object.assign(
          new Error('A payment is already in progress for this bill. Refresh status instead.'),
          { status: 400 }
        );
      }

      const amount = Number(bill.grandTotal || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw Object.assign(new Error('Bill total must be greater than zero.'), { status: 400 });
      }

      let recipient = recipientOverride;
      let vendorName = String(bill.vendorName || 'Vendor');
      if (bill.vendorId) {
        const vendorSnap = await getAdminDb()
          .doc(`tenants/${tenantId}/vendors/${bill.vendorId}`)
          .get();
        if (vendorSnap.exists) {
          const vendor = vendorSnap.data() as {
            name?: string;
            contactEmail?: string;
          };
          vendorName = String(vendor.name || vendorName);
          if (!recipient) recipient = String(vendor.contactEmail || '').trim();
        }
      }

      if (!recipient || !recipient.includes('@')) {
        throw Object.assign(
          new Error(
            'Vendor needs an email address so Checkbook can send the ACH deposit link. Add one on the vendor, or enter it when paying.'
          ),
          { status: 400 }
        );
      }

      const description = `NurseryOS bill ${bill.billNumber || billId}`.slice(0, 100);
      const body = {
        name: vendorName.slice(0, 100),
        recipient,
        amount: Math.round(amount * 100) / 100,
        description,
        comment: `tenant:${tenantId}|bill:${billId}`
      };

      const payRes = await checkbookFetch(integration, '/v3/check/digital', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (!payRes.ok) {
        throw Object.assign(new Error(await readCheckbookError(payRes)), { status: 400 });
      }

      const payment = (await payRes.json()) as {
        id?: string;
        status?: string;
        number?: number;
      };
      const paymentId = String(payment.id || '').trim();
      if (!paymentId) {
        throw Object.assign(new Error('Checkbook did not return a payment id.'), { status: 502 });
      }

      const now = new Date().toISOString();
      await billRef.set(
        {
          status: 'payment_pending',
          paymentMethod: 'ach',
          paymentReference: paymentId,
          checkbookPaymentId: paymentId,
          checkbookPaymentStatus: payment.status || 'UNPAID',
          checkbookPaymentNumber: payment.number ?? null,
          checkbookRecipient: recipient,
          checkbookPaymentError: null,
          updatedAt: now
        },
        { merge: true }
      );

      res.json({
        paymentId,
        status: payment.status || 'UNPAID',
        recipient,
        amount
      });
    })
  );

  app.post('/api/checkbook/refresh-bill', (req, res) =>
    void handleAsync(res, async () => {
      const tenantId = String(req.body?.tenantId || '').trim();
      const billId = String(req.body?.billId || '').trim();
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }

      const uid = await readBearerUid(req);
      await assertCanPayBills(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration) {
        throw Object.assign(new Error('Checkbook is not connected.'), { status: 400 });
      }

      const billRef = getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`);
      const billSnap = await billRef.get();
      if (!billSnap.exists) {
        throw Object.assign(new Error('Vendor bill not found.'), { status: 404 });
      }
      const bill = billSnap.data() as { checkbookPaymentId?: string };
      const paymentId = String(bill.checkbookPaymentId || '').trim();
      if (!paymentId) {
        throw Object.assign(new Error('No Checkbook payment on this bill.'), { status: 400 });
      }

      const payRes = await checkbookFetch(integration, `/v3/check/${paymentId}`);
      if (!payRes.ok) {
        throw Object.assign(new Error(await readCheckbookError(payRes)), { status: 400 });
      }
      const payment = (await payRes.json()) as { id?: string; status?: string };

      await applyPaymentStatusToBill({
        tenantId,
        billId,
        paymentId,
        checkbookStatus: String(payment.status || ''),
        depositOption: null
      });

      res.json({ paymentId, status: payment.status || null });
    })
  );
}
