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
  /** Resolved API host that accepted these keys. */
  apiBase: string;
  connectedAt: string;
  connectedByUserId: string;
  updatedAt: string;
  /** Last 4 of publishable key for UI display only. */
  publishableKeyLast4: string;
}

const CHECKBOOK_HOSTS: Record<CheckbookEnvironment, string[]> = {
  sandbox: [
    'https://api.sandbox.checkbook.io',
    'https://sandbox.checkbook.io',
    'https://demo.checkbook.io'
  ],
  production: ['https://api.checkbook.io']
};

function checkbookBase(integration: Pick<CheckbookIntegration, 'environment' | 'apiBase'>): string {
  if (integration.apiBase) return integration.apiBase.replace(/\/$/, '');
  return CHECKBOOK_HOSTS[integration.environment][0];
}

function normalizeCheckbookKey(value: string): string {
  return value
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
}

function splitPastedKeys(
  publishableKey: string,
  secretKey: string
): { publishableKey: string; secretKey: string } {
  let pub = normalizeCheckbookKey(publishableKey);
  let secret = normalizeCheckbookKey(secretKey);
  // User pasted "publishable:secret" into the first field
  if (pub.includes(':') && !secret) {
    const [a, ...rest] = pub.split(':');
    pub = a;
    secret = rest.join(':');
  }
  // Swapped fields: secret-looking long key in publishable alone is hard to detect;
  // if publishable contains a colon and secret also set, prefer left/right of publishable.
  if (pub.includes(':') && secret) {
    const [a, ...rest] = pub.split(':');
    if (rest.join(':') === secret || !secret) {
      pub = a;
      secret = rest.join(':') || secret;
    }
  }
  return { publishableKey: pub, secretKey: secret };
}

async function probeCheckbookKeys(
  environment: CheckbookEnvironment,
  publishableKey: string,
  secretKey: string
): Promise<{ apiBase: string }> {
  const auth = `${publishableKey}:${secretKey}`;
  const hosts = CHECKBOOK_HOSTS[environment];
  const errors: string[] = [];

  for (const host of hosts) {
    try {
      const probe = await fetch(`${host}/v3/check?page=1`, {
        headers: {
          Authorization: auth,
          Accept: 'application/json'
        }
      });
      if (probe.ok || probe.status === 404) {
        return { apiBase: host };
      }
      // Some accounts return empty list as 200; 401/403 means wrong host or wrong keys
      const detail = await readCheckbookError(probe);
      errors.push(`${host.replace(/^https:\/\//, '')}: ${detail}`);
      if (probe.status !== 401 && probe.status !== 403) {
        // Unexpected but host accepted auth shape — still treat non-auth errors carefully
        if (probe.status === 400 && /invalid key/i.test(detail)) {
          continue;
        }
      }
    } catch (err) {
      errors.push(
        `${host.replace(/^https:\/\//, '')}: ${err instanceof Error ? err.message : 'network error'}`
      );
    }
  }

  throw Object.assign(
    new Error(
      `Could not verify Checkbook keys (${environment}). ${errors.join(' · ') || 'Unauthorized'}. ` +
        `In Checkbook go to Settings → Developer, switch to ${
          environment === 'production' ? 'Production' : 'Sandbox'
        }, generate keys there, then paste those keys and choose ${environment} in NurseryOS.`
    ),
    { status: 400 }
  );
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
  const url = `${checkbookBase(integration)}${path}`;
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
  let message = '';
  try {
    const data = JSON.parse(text) as { error?: string; message?: string; codes?: unknown };
    if (data?.error) message = String(data.error);
    else if (data?.message) message = String(data.message);
  } catch {
    // non-JSON
  }
  if (!message && text?.trim()) message = text.trim().slice(0, 280);
  if (!message) message = `Checkbook request failed (${res.status})`;

  const lower = message.toLowerCase();
  if (
    lower.includes('sending limit') ||
    lower.includes('send limit') ||
    lower.includes('limits exceeded') ||
    lower.includes('limit exceeded')
  ) {
    return (
      `${message} This is a Checkbook account restriction (not the bill amount). ` +
      'Even a small payment fails if: (1) the API keys in NurseryOS don’t see a verified bank (wrong sandbox/production keys), ' +
      '(2) today’s/month’s send capacity is already used by pending payments, or ' +
      '(3) your Checkbook send limit is still $0. ' +
      'In Checkbook: confirm Settings → Accounts shows VERIFIED, cancel unused pending payments, match Developer keys to the same environment, then retry.'
    );
  }
  return message;
}

type CheckbookBankAccount = {
  id: string;
  status?: string;
  default?: boolean;
  account?: string;
  name?: string | null;
};

async function listCheckbookBanks(
  integration: CheckbookIntegration
): Promise<CheckbookBankAccount[]> {
  const res = await checkbookFetch(integration, '/v3/account/bank');
  if (!res.ok) {
    throw Object.assign(new Error(await readCheckbookError(res)), { status: 400 });
  }
  const body = (await res.json()) as
    | CheckbookBankAccount[]
    | { banks?: CheckbookBankAccount[]; data?: CheckbookBankAccount[]; accounts?: CheckbookBankAccount[] };
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.banks)) return body.banks;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.accounts)) return body.accounts;
  return [];
}

function pickFundingBankAccount(banks: CheckbookBankAccount[]): CheckbookBankAccount | null {
  const verified = banks.filter((b) => String(b.status || '').toUpperCase() === 'VERIFIED');
  if (verified.length === 0) return null;
  return verified.find((b) => b.default) || verified[0] || null;
}

async function resolveFundingAccountId(integration: CheckbookIntegration): Promise<{
  accountId: string;
  banks: CheckbookBankAccount[];
}> {
  const banks = await listCheckbookBanks(integration);
  const funding = pickFundingBankAccount(banks);
  if (!funding?.id) {
    const statuses = banks
      .map((b) => `${b.id?.slice(0, 8) || '?'}…=${String(b.status || 'unknown')}`)
      .slice(0, 6)
      .join(', ');
    throw Object.assign(
      new Error(
        banks.length === 0
          ? `No bank accounts found for these Checkbook API keys (${integration.environment}). ` +
              'You may have verified a bank in the Checkbook website under a different login/environment. ' +
              'In Checkbook Developer settings, copy keys from the same environment (sandbox vs production) where the bank shows as Verified, then reconnect in Team.'
          : `No VERIFIED bank account on these Checkbook API keys (${integration.environment}). ` +
              `Found: ${statuses || 'none'}. Finish micro-deposit verification for that environment, or reconnect keys from the account that has the verified bank.`
      ),
      { status: 400 }
    );
  }
  return { accountId: funding.id, banks };
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

/** Sandbox-only: Checkbook ACH often stays IN_PROCESS; force a terminal PAID for testing. */
async function completeSandboxPayment(
  integration: CheckbookIntegration,
  paymentId: string
): Promise<string | null> {
  if (integration.environment !== 'sandbox') return null;
  const putRes = await checkbookFetch(integration, `/v3/check/webhook/${paymentId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'PAID' })
  });
  if (!putRes.ok) {
    console.warn('[checkbook] sandbox status simulate failed', await readCheckbookError(putRes));
    return null;
  }
  return 'PAID';
}

async function fetchCheckbookPayment(
  integration: CheckbookIntegration,
  paymentId: string
): Promise<{ id?: string; status?: string; deposit_option?: string }> {
  const payRes = await checkbookFetch(integration, `/v3/check/${paymentId}`);
  if (!payRes.ok) {
    throw Object.assign(new Error(await readCheckbookError(payRes)), { status: 400 });
  }
  return (await payRes.json()) as {
    id?: string;
    status?: string;
    deposit_option?: string;
  };
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
          .limit(50)
          .get();

        if (billsSnap.empty) {
          // Acknowledge — payment may not be from NurseryOS
          res.json({ ok: true, matched: false });
          return;
        }

        const billIds: string[] = [];
        for (const doc of billsSnap.docs) {
          billIds.push(doc.id);
          await applyPaymentStatusToBill({
            tenantId,
            billId: doc.id,
            paymentId,
            checkbookStatus: status,
            depositOption: payload.deposit_option || null
          });
        }

        res.json({ ok: true, matched: true, billIds });
      })
  );
}

export function registerCheckbookRoutes(app: Express) {
  app.get('/api/checkbook/health', (_req, res) => {
    res.json({
      ok: true,
      connectVersion: 4,
      hosts: {
        sandbox: CHECKBOOK_HOSTS.sandbox,
        production: CHECKBOOK_HOSTS.production
      }
    });
  });

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
      let bankSummary: {
        total: number;
        verified: number;
        fundingAccountLast4: string | null;
        statuses: string[];
      } | null = null;
      if (integration) {
        try {
          const banks = await listCheckbookBanks(integration);
          const funding = pickFundingBankAccount(banks);
          bankSummary = {
            total: banks.length,
            verified: banks.filter((b) => String(b.status || '').toUpperCase() === 'VERIFIED')
              .length,
            fundingAccountLast4: funding?.account
              ? String(funding.account).replace(/\D/g, '').slice(-4) || null
              : null,
            statuses: banks.map((b) => String(b.status || 'unknown').toUpperCase()).slice(0, 8)
          };
        } catch {
          bankSummary = { total: 0, verified: 0, fundingAccountLast4: null, statuses: [] };
        }
      }
      res.json({
        connected: Boolean(integration),
        environment: integration?.environment || null,
        apiBase: integration?.apiBase || null,
        publishableKeyLast4: integration?.publishableKeyLast4 || null,
        hasWebhookKey: Boolean(integration?.webhookKey),
        connectedAt: integration?.connectedAt || null,
        bankSummary,
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

      const keys = splitPastedKeys(publishableKey, secretKey);
      if (!keys.publishableKey || !keys.secretKey) {
        res.status(400).json({ error: 'Publishable key and secret key are both required.' });
        return;
      }

      const { apiBase } = await probeCheckbookKeys(
        environment,
        keys.publishableKey,
        keys.secretKey
      );

      const now = new Date().toISOString();
      const existing = await loadIntegration(tenantId);
      const resolvedWebhook = (webhookKey || existing?.webhookKey || '').trim();

      const clean: Record<string, string> = {
        provider: 'checkbook',
        publishableKey: keys.publishableKey,
        secretKey: keys.secretKey,
        environment,
        apiBase,
        connectedAt: existing?.connectedAt || now,
        connectedByUserId: uid,
        updatedAt: now,
        publishableKeyLast4: last4(keys.publishableKey)
      };
      if (resolvedWebhook) {
        clean.webhookKey = resolvedWebhook;
      }

      await integrationRef(tenantId).set(clean, { merge: true });

      res.json({
        connected: true,
        environment,
        apiBase,
        publishableKeyLast4: clean.publishableKeyLast4,
        hasWebhookKey: Boolean(resolvedWebhook),
        connectedAt: clean.connectedAt,
        webhookUrl: `${(process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '')}/api/checkbook/webhook?tenantId=${encodeURIComponent(tenantId)}`,
        connectVersion: 4
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
      const singleBillId = String(req.body?.billId || '').trim();
      const billIdsRaw = Array.isArray(req.body?.billIds) ? req.body.billIds : [];
      const billIds = [
        ...new Set(
          [singleBillId, ...billIdsRaw.map((id: unknown) => String(id || '').trim())].filter(
            Boolean
          )
        )
      ];
      const recipientOverride = String(req.body?.recipientEmail || '').trim();

      if (!tenantId || billIds.length === 0) {
        res.status(400).json({ error: 'tenantId and billId(s) are required.' });
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

      type BillRow = {
        id: string;
        status?: string;
        vendorId?: string;
        vendorName?: string;
        billNumber?: string;
        grandTotal?: number;
        checkbookPaymentId?: string;
      };

      const bills: BillRow[] = [];
      for (const billId of billIds) {
        const billSnap = await getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`).get();
        if (!billSnap.exists) {
          throw Object.assign(new Error(`Vendor bill not found (${billId}).`), { status: 404 });
        }
        bills.push({ id: billId, ...(billSnap.data() as Omit<BillRow, 'id'>) });
      }

      for (const bill of bills) {
        if (bill.status === 'paid') {
          throw Object.assign(
            new Error(`Bill ${bill.billNumber || bill.id} is already marked paid.`),
            { status: 400 }
          );
        }
        if (bill.status === 'payment_pending' && bill.checkbookPaymentId) {
          throw Object.assign(
            new Error(
              `Bill ${bill.billNumber || bill.id} already has an ACH payment in progress. Refresh status instead.`
            ),
            { status: 400 }
          );
        }
      }

      const vendorIds = [
        ...new Set(bills.map((b) => String(b.vendorId || '').trim()).filter(Boolean))
      ];
      if (vendorIds.length > 1) {
        throw Object.assign(new Error('All selected bills must be for the same vendor.'), {
          status: 400
        });
      }

      const amount = bills.reduce((sum, bill) => {
        const n = Number(bill.grandTotal || 0);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw Object.assign(new Error('Combined bill total must be greater than zero.'), {
          status: 400
        });
      }

      let recipient = recipientOverride;
      let vendorName = String(bills[0]?.vendorName || 'Vendor');
      const vendorId = vendorIds[0] || String(bills[0]?.vendorId || '').trim();
      if (vendorId) {
        const vendorSnap = await getAdminDb().doc(`tenants/${tenantId}/vendors/${vendorId}`).get();
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

      const billNumbers = bills
        .map((b) => String(b.billNumber || b.id).trim())
        .filter(Boolean)
        .slice(0, 8);
      const description =
        bills.length === 1
          ? `NurseryOS bill ${billNumbers[0] || bills[0].id}`.slice(0, 100)
          : `NurseryOS bills ${billNumbers.join(', ')}${
              bills.length > billNumbers.length ? '…' : ''
            } (${bills.length} bills)`.slice(0, 100);
      const { accountId, banks } = await resolveFundingAccountId(integration);
      const payAmount = Math.round(amount * 100) / 100;
      const body = {
        name: vendorName.slice(0, 100),
        recipient,
        amount: payAmount,
        description,
        comment: `tenant:${tenantId}|bills:${billIds.join(',')}`,
        account: accountId,
        deposit_options: ['BANK']
      };

      console.log('[checkbook] pay-bill', {
        tenantId,
        environment: integration.environment,
        apiBase: checkbookBase(integration),
        amount: payAmount,
        billCount: bills.length,
        fundingAccountId: accountId,
        verifiedBanks: banks.filter((b) => String(b.status || '').toUpperCase() === 'VERIFIED')
          .length,
        recipient
      });

      const payRes = await checkbookFetch(integration, '/v3/check/digital', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (!payRes.ok) {
        const detail = await readCheckbookError(payRes);
        throw Object.assign(
          new Error(
            `${detail} [sent $${payAmount.toFixed(2)} via ${integration.environment} · ` +
              `${banks.filter((b) => String(b.status || '').toUpperCase() === 'VERIFIED').length} verified bank(s)]`
          ),
          { status: 400 }
        );
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
      const batch = getAdminDb().batch();
      for (const bill of bills) {
        batch.set(
          getAdminDb().doc(`tenants/${tenantId}/vendorBills/${bill.id}`),
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
      }
      await batch.commit();

      res.json({
        paymentId,
        status: payment.status || 'UNPAID',
        recipient,
        amount: Math.round(amount * 100) / 100,
        billIds,
        billCount: bills.length
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

      let payment = await fetchCheckbookPayment(integration, paymentId);
      let status = String(payment.status || '').toUpperCase();

      // Sandbox ACH often never leaves IN_PROCESS / "ACH pending". Simulate PAID
      // via Checkbook's sandbox webhook endpoint so NurseryOS can mark the bill paid.
      const terminal =
        status === 'PAID' ||
        status === 'FAILED' ||
        status === 'VOID' ||
        status === 'EXPIRED' ||
        status === 'REFUNDED';
      if (integration.environment === 'sandbox' && !terminal) {
        const forced = await completeSandboxPayment(integration, paymentId);
        if (forced) {
          payment = await fetchCheckbookPayment(integration, paymentId);
          status = String(payment.status || forced).toUpperCase();
        }
      }

      const linkedSnap = await getAdminDb()
        .collection(`tenants/${tenantId}/vendorBills`)
        .where('checkbookPaymentId', '==', paymentId)
        .limit(50)
        .get();
      const linkedIds = linkedSnap.empty ? [billId] : linkedSnap.docs.map((d) => d.id);

      for (const linkedId of linkedIds) {
        await applyPaymentStatusToBill({
          tenantId,
          billId: linkedId,
          paymentId,
          checkbookStatus: status || String(payment.status || ''),
          depositOption: payment.deposit_option || null
        });
      }

      res.json({
        paymentId,
        status: status || payment.status || null,
        environment: integration.environment,
        billIds: linkedIds
      });
    })
  );
}
