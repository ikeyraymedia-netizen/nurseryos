import type { Express, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { legacyMelioWebhookSecret, verifyMelioWebhook } from './melioWebhook';

interface MelioIntegration {
  provider: 'melio';
  entityId: string;
  entityName?: string | null;
  kycStatus?: string | null;
  fundingAccountId?: string | null;
  fundingAccountLast4?: string | null;
  fundingAccountName?: string | null;
  environment: 'sandbox' | 'production';
  connectedAt: string;
  connectedByUserId: string;
  updatedAt: string;
  /** Set when this nursery's owner accepted Melio's terms on business create. */
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
  termsAcceptedByUserId?: string | null;
}

interface MelioAccount {
  id: string;
  type?: string;
  ownershipType?: string;
  direction?: string;
  isVerified?: boolean;
  status?: string;
  last4?: string;
  nickname?: string;
  name?: string;
  institutionName?: string;
  externalId?: string;
  bankAccount?: {
    accountType?: string;
    accountNumberLast4?: string;
    institutionName?: string;
    bankName?: string;
    name?: string;
  };
}

interface MelioPayment {
  id: string;
  status?: string;
  amount?: number;
  failureReason?: string;
  failureMessage?: string;
  error?: { message?: string };
}

const MELIO_BASE_URLS = {
  sandbox: 'https://api.staging01.melio.com/v2',
  production: 'https://api.melio.com/v2'
};

/** Published revision date of the Melio terms the owner is shown. Must match the version in force. */
const MELIO_TERMS_VERSION = '2026-06-24';

function melioEnvironment(): 'sandbox' | 'production' {
  return String(process.env.MELIO_ENV || 'sandbox').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

function melioBaseUrl(): string {
  const override = process.env.MELIO_API_BASE_URL?.trim();
  return (override || MELIO_BASE_URLS[melioEnvironment()]).replace(/\/$/, '');
}

export function isMelioConfigured(): boolean {
  return Boolean(process.env.MELIO_API_KEY?.trim());
}

function requireMelioKey(): string {
  const key = process.env.MELIO_API_KEY?.trim();
  if (!key) {
    throw Object.assign(
      new Error('Melio is not configured. Set MELIO_API_KEY (and MELIO_ENV) on the server.'),
      { status: 503 }
    );
  }
  return key;
}

function appOrigin(): string {
  return (process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '');
}

class MelioApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function melioFetch<T>(
  path: string,
  options: {
    method?: string;
    entityId?: string | null;
    body?: unknown;
    idempotencyKey?: string;
    sonarToken?: string | null;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'api-key': requireMelioKey(),
    Accept: 'application/json'
  };
  if (options.entityId) headers['Melio-Entity-Id'] = options.entityId;
  if (options.sonarToken) headers['Melio-Sonar-Token'] = options.sonarToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const res = await fetch(`${melioBaseUrl()}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error || json;
    const details = Array.isArray(err?.details)
      ? err.details
          .map((d: any) =>
            [d?.field || d?.path || d?.param, d?.message || d?.reason].filter(Boolean).join(': ')
          )
          .filter(Boolean)
          .join('; ')
      : '';
    const base = err?.message || text?.slice(0, 300) || `Melio request failed (${res.status})`;
    const detail = details && !base.includes(details) ? `${base} (${details})` : base;
    throw new MelioApiError(`Melio: ${detail}`, res.status, err?.code);
  }
  return json as T;
}

/** Melio wraps some responses in `{ data }` and returns others bare. */
function unwrap<T>(json: any): T {
  return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
}

function isInternalAccount(acct: MelioAccount): boolean {
  return acct.ownershipType === 'internal' || acct.direction === 'source';
}

function integrationRef(tenantId: string) {
  return getAdminDb().doc(`tenants/${tenantId}/integrations/melio`);
}

function entityTenantRef(entityId: string) {
  return getAdminDb().doc(`melioEntities/${entityId}`);
}

async function loadIntegration(tenantId: string): Promise<MelioIntegration | null> {
  const snap = await integrationRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() as MelioIntegration;
}

async function saveEntityLink(
  tenantId: string,
  uid: string,
  entity: any,
  terms?: { version: string; acceptedAt: string }
) {
  const now = new Date().toISOString();
  const entityId = String(entity?.id || '').trim();
  if (!entityId) throw Object.assign(new Error('Melio did not return an entity id.'), { status: 502 });
  const recorded = entity?.termsAcceptance;
  const integration: MelioIntegration = {
    provider: 'melio',
    entityId,
    entityName: entity?.name || entity?.legalName || null,
    kycStatus: entity?.kycStatus || entity?.status || null,
    fundingAccountId: null,
    fundingAccountLast4: null,
    fundingAccountName: null,
    environment: melioEnvironment(),
    connectedAt: now,
    connectedByUserId: uid,
    updatedAt: now,
    ...(terms
      ? {
          termsVersion: String(recorded?.version || terms.version),
          termsAcceptedAt: String(recorded?.acceptedAt || terms.acceptedAt),
          termsAcceptedByUserId: uid
        }
      : {})
  };
  await integrationRef(tenantId).set(integration);
  await entityTenantRef(entityId).set({ tenantId, updatedAt: now }, { merge: true });
  return integration;
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

async function assertMelioModuleEnabled(tenantId: string) {
  const snap = await getAdminDb().doc(`tenants/${tenantId}`).get();
  const modules: unknown = snap.data()?.modules;
  const list = Array.isArray(modules) ? modules.map(String) : [];
  if (!list.includes('melioBillPay') || !list.includes('purchasing')) {
    throw Object.assign(
      new Error('Melio Bill Pay is not turned on for this nursery.'),
      { status: 403 }
    );
  }
}

async function assertAdminOrOwner(tenantId: string, uid: string) {
  await assertMelioModuleEnabled(tenantId);
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin'])) {
    throw Object.assign(new Error('Only owners and admins can manage Melio.'), { status: 403 });
  }
}

async function assertCanPayVendorBills(tenantId: string, uid: string) {
  await assertMelioModuleEnabled(tenantId);
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office'])) {
    throw Object.assign(new Error('You do not have permission to pay vendor bills.'), {
      status: 403
    });
  }
}

function httpError(res: Response, err: any) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[melio]', err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: err?.message || 'Melio request failed.'
  });
}

async function withAuth(req: Request, res: Response, fn: (uid: string) => Promise<void>) {
  try {
    const uid = await readBearerUid(req);
    await fn(uid);
  } catch (err: any) {
    httpError(res, err);
  }
}

function tenantIdFrom(req: Request): string {
  return String(req.body?.tenantId || req.query.tenantId || '').trim();
}

function mapPaymentStatus(status: string): 'payment_pending' | 'paid' | 'unpaid' | null {
  const s = status.toLowerCase();
  if (s === 'completed') return 'paid';
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') return 'unpaid';
  if (s === 'scheduled' || s === 'in-progress' || s === 'in_progress') return 'payment_pending';
  return null;
}

async function applyPaymentToBill(params: {
  tenantId: string;
  billId: string;
  payment: MelioPayment;
}) {
  const status = String(params.payment.status || '');
  const mapped = mapPaymentStatus(status);
  if (!mapped) return;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    melioPaymentId: params.payment.id,
    melioPaymentStatus: status,
    updatedAt: now
  };
  if (mapped === 'paid') {
    patch.status = 'paid';
    patch.paidAt = now;
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.payment.id;
    patch.melioPaymentError = null;
  } else if (mapped === 'unpaid') {
    patch.status = 'unpaid';
    patch.paidAt = null;
    patch.melioPaymentError =
      params.payment.failureMessage ||
      params.payment.failureReason ||
      params.payment.error?.message ||
      `Melio payment ${status}`;
  } else {
    patch.status = 'payment_pending';
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.payment.id;
    patch.melioPaymentError = null;
  }

  await getAdminDb()
    .doc(`tenants/${params.tenantId}/vendorBills/${params.billId}`)
    .set(patch, { merge: true });

  if (mapped === 'paid') {
    try {
      const { syncPaidVendorBillPaymentToQbo } = await import('./quickbooks');
      await syncPaidVendorBillPaymentToQbo(params.tenantId, params.billId, { uid: 'melio' });
    } catch (err) {
      console.warn('[melio] QBO bill payment sync failed', params.billId, err);
    }
  }
}

async function applyPaymentToAllBills(tenantId: string, payment: MelioPayment) {
  const snap = await getAdminDb()
    .collection(`tenants/${tenantId}/vendorBills`)
    .where('melioPaymentId', '==', payment.id)
    .limit(50)
    .get();
  for (const doc of snap.docs) {
    await applyPaymentToBill({ tenantId, billId: doc.id, payment });
  }
  return snap.size;
}

async function listAccounts(entityId: string): Promise<MelioAccount[]> {
  const json = await melioFetch<any>('/accounts', { entityId });
  const rows = unwrap<any>(json);
  if (Array.isArray(rows)) return rows as MelioAccount[];
  if (Array.isArray(rows?.items)) return rows.items as MelioAccount[];
  if (Array.isArray(json?.items)) return json.items as MelioAccount[];
  return [];
}

function accountLast4(acct: MelioAccount): string | null {
  const raw = acct.last4 || acct.bankAccount?.accountNumberLast4 || '';
  const digits = String(raw).replace(/\D/g, '').slice(-4);
  return digits || null;
}

function accountLabel(acct: MelioAccount): string {
  const nick = String(acct.nickname || acct.name || '').trim();
  if (nick && !/^(ach|plaid|bank)$/i.test(nick)) return nick;
  const bank = acct.bankAccount;
  const institution = String(
    acct.institutionName || bank?.institutionName || bank?.bankName || bank?.name || ''
  ).trim();
  const kind = String(bank?.accountType || '').toLowerCase();
  const kindLabel =
    kind === 'checking'
      ? 'Checking account'
      : kind === 'savings'
        ? 'Savings account'
        : 'Bank account';
  return institution ? `${institution} ${kindLabel.toLowerCase()}` : kindLabel;
}

function todayIsoDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Create (or reuse) the vendor's Melio ACH payee account. Re-created when bank details change. */
async function ensureVendorPayeeAccount(params: {
  tenantId: string;
  entityId: string;
  vendorId: string;
  vendorName: string;
  holderName?: string;
  email: string;
  routing: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  existingAccountId?: string | null;
  existingFingerprint?: string | null;
  sonarToken?: string | null;
}): Promise<string> {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${params.entityId}:${params.routing}:${params.accountNumber}`)
    .digest('hex')
    .slice(0, 24);
  if (params.existingAccountId && params.existingFingerprint === fingerprint) {
    return params.existingAccountId;
  }

  const nickname = params.vendorName.slice(0, 80);
  const counterPartyName = (params.holderName || params.vendorName).slice(0, 80);
  const externalId = `vendor-${params.vendorId}`;
  const bank = {
    routingNumber: params.routing,
    accountNumber: params.accountNumber,
    accountType: params.accountType
  };
  const head = {
    type: 'ach',
    ownershipType: 'external',
    counterPartyName,
    counterPartyEmail: params.email,
    nickname
  };
  const created = unwrap<MelioAccount>(
    await melioFetch<any>('/accounts', {
      method: 'POST',
      entityId: params.entityId,
      body: { ...head, externalId, bankAccount: bank },
      idempotencyKey: `nos-payee-${fingerprint}`,
      sonarToken: params.sonarToken
    })
  );
  if (!created?.id) {
    throw Object.assign(new Error('Melio did not return a payee account id.'), { status: 502 });
  }
  await getAdminDb()
    .doc(`tenants/${params.tenantId}/vendors/${params.vendorId}`)
    .set(
      {
        melioPayeeAccountId: created.id,
        melioPayeeFingerprint: fingerprint,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );
  return created.id;
}

function sonarTokenFrom(req: Request): string | undefined {
  const token = String(req.body?.sonarToken || '').trim();
  return token || undefined;
}

function asList<T>(json: any, key: string): T[] {
  const raw = unwrap<any>(json);
  if (Array.isArray(raw)) return raw as T[];
  if (Array.isArray(raw?.[key])) return raw[key] as T[];
  if (Array.isArray(raw?.items)) return raw.items as T[];
  return [];
}

type PreparedMelioPay = {
  entityId: string;
  fundingAccountId: string;
  bills: Array<{ id: string; data: Record<string, any> }>;
  amountCents: number;
  receivingAccountId: string;
  last4: string;
  vendorName: string;
};

async function prepareMelioPayment(
  tenantId: string,
  billIds: string[],
  sonarToken?: string
): Promise<PreparedMelioPay> {
  const integration = await loadIntegration(tenantId);
  if (!integration?.entityId || !integration.fundingAccountId) {
    throw Object.assign(
      new Error('Connect Melio and choose a funding account in Team before paying bills.'),
      { status: 400 }
    );
  }
  const funding = unwrap<MelioAccount>(
    await melioFetch<any>(`/accounts/${encodeURIComponent(integration.fundingAccountId)}`, {
      entityId: integration.entityId
    })
  );
  if (funding?.isVerified === false) {
    throw Object.assign(
      new Error('The Melio funding account is not verified. Finish verification in Team.'),
      { status: 400 }
    );
  }

  const uniqueIds = [...new Set(billIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw Object.assign(new Error('billIds is required.'), { status: 400 });
  }
  const snaps = await Promise.all(
    uniqueIds.map((id) => getAdminDb().doc(`tenants/${tenantId}/vendorBills/${id}`).get())
  );
  const bills = snaps
    .filter((snap) => snap.exists)
    .map((snap) => ({ id: snap.id, data: (snap.data() || {}) as Record<string, any> }));
  if (bills.length !== uniqueIds.length) {
    throw Object.assign(new Error('One or more bills were not found.'), { status: 404 });
  }
  const vendorIds = new Set(bills.map((b) => b.data.vendorId));
  if (vendorIds.size !== 1) {
    throw Object.assign(new Error('Selected bills must be for the same vendor.'), { status: 400 });
  }
  for (const bill of bills) {
    if (bill.data.status === 'paid' || bill.data.status === 'void') {
      throw Object.assign(new Error(`Bill ${bill.data.billNumber || bill.id} is already closed.`), {
        status: 400
      });
    }
    if (bill.data.status === 'payment_pending' || bill.data.melioPaymentId) {
      throw Object.assign(
        new Error(`Bill ${bill.data.billNumber || bill.id} already has a Melio payment in progress.`),
        { status: 400 }
      );
    }
  }
  const amount = Number(bills.reduce((sum, b) => sum + (Number(b.data.grandTotal) || 0), 0).toFixed(2));
  if (!(amount > 0)) {
    throw Object.assign(new Error('Bill total must be greater than zero.'), { status: 400 });
  }

  const vendorId = String(bills[0].data.vendorId || '');
  const vendorSnap = await getAdminDb().doc(`tenants/${tenantId}/vendors/${vendorId}`).get();
  if (!vendorSnap.exists) {
    throw Object.assign(new Error('Vendor not found.'), { status: 404 });
  }
  const vendor = (vendorSnap.data() || {}) as Record<string, any>;
  const routing = String(vendor.bankRoutingNumber || '').replace(/\D/g, '');
  const accountNumber = String(vendor.bankAccountNumber || '').replace(/\s/g, '');
  if (routing.length !== 9 || accountNumber.length < 4) {
    throw Object.assign(
      new Error(
        'Add the vendor’s bank routing and account numbers in Purchasing → Vendors before paying via Melio.'
      ),
      { status: 400 }
    );
  }
  const vendorName = String(vendor.name || bills[0].data.vendorName || 'Vendor');
  const email = String(vendor.contactEmail || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .find((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (!email) {
    throw Object.assign(
      new Error(
        `Add an email for ${vendorName} in Purchasing → Vendors. Melio uses it to notify the vendor about the payment.`
      ),
      { status: 400 }
    );
  }
  const last4 =
    String(vendor.bankAccountLast4 || '').replace(/\D/g, '').slice(-4) ||
    accountNumber.replace(/\D/g, '').slice(-4);

  const receivingAccountId = await ensureVendorPayeeAccount({
    tenantId,
    entityId: integration.entityId,
    vendorId,
    vendorName,
    holderName: String(vendor.bankAccountHolderName || vendor.contactName || '').trim(),
    email,
    routing,
    accountNumber,
    accountType:
      String(vendor.bankAccountType || 'checking').toLowerCase() === 'savings'
        ? 'savings'
        : 'checking',
    existingAccountId: vendor.melioPayeeAccountId,
    existingFingerprint: vendor.melioPayeeFingerprint,
    sonarToken
  });

  return {
    entityId: integration.entityId,
    fundingAccountId: integration.fundingAccountId,
    bills,
    amountCents: Math.round(amount * 100),
    receivingAccountId,
    last4,
    vendorName
  };
}

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

export function registerMelioWebhookRoute(app: Express) {
  app.post('/api/melio/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    if (!isMelioConfigured() || !isFirebaseAdminConfigured()) {
      res.status(503).send('Melio or Firebase Admin not configured');
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    const webhookSecret = process.env.MELIO_WEBHOOK_SECRET?.trim() || '';
    if (
      !verifyMelioWebhook({
        rawBody,
        webhookId: headerValue(req, 'webhook-id'),
        webhookTimestamp: headerValue(req, 'webhook-timestamp'),
        webhookSignature: headerValue(req, 'webhook-signature'),
        legacySignature: headerValue(req, 'x-melio-signature'),
        webhookSecret,
        legacySecret: legacyMelioWebhookSecret(webhookSecret, process.env.MELIO_API_KEY?.trim() || '')
      })
    ) {
      res.status(400).send('Invalid signature');
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).send('Invalid JSON');
      return;
    }

    const messageId = String(
      event?.messageId ||
        headerValue(req, 'webhook-id') ||
        headerValue(req, 'x-melio-delivery-id') ||
        ''
    ).trim();
    try {
      if (messageId) {
        const seenRef = getAdminDb().doc(`melioWebhookEvents/${messageId}`);
        const seen = await seenRef.get();
        if (seen.exists) {
          res.json({ received: true, duplicate: true });
          return;
        }
      }

      const type = String(event?.event || '');
      const entityId = String(event?.entityId || '').trim();
      let tenantId = String(event?.metadata?.tenantId || '').trim();
      if (!tenantId && entityId) {
        const link = await entityTenantRef(entityId).get();
        tenantId = String(link.data()?.tenantId || '').trim();
      }

      if (tenantId && entityId && type.startsWith('api.payment.')) {
        const payment = unwrap<MelioPayment>(
          await melioFetch<any>(`/payments/${encodeURIComponent(String(event.id))}`, { entityId })
        );
        if (payment?.id) await applyPaymentToAllBills(tenantId, payment);
      } else if (tenantId && type === 'api.entity.updated') {
        const entity = unwrap<any>(
          await melioFetch<any>(`/entities/${encodeURIComponent(entityId)}`)
        );
        await integrationRef(tenantId).set(
          {
            kycStatus: entity?.kycStatus || entity?.status || null,
            updatedAt: new Date().toISOString()
          },
          { merge: true }
        );
      }

      if (messageId) {
        await getAdminDb()
          .doc(`melioWebhookEvents/${messageId}`)
          .set({ event: type, tenantId: tenantId || null, receivedAt: new Date().toISOString() });
      }
      res.json({ received: true });
    } catch (err) {
      console.error('[melio] webhook handling failed', err);
      res.status(500).send('Webhook handling failed');
    }
  });
}

export function registerMelioRoutes(app: Express) {
  app.get('/api/melio/config-status', (_req, res) => {
    res.json({
      configured: isMelioConfigured() && isFirebaseAdminConfigured(),
      melio: isMelioConfigured(),
      firebaseAdmin: isFirebaseAdminConfigured(),
      environment: melioEnvironment(),
      baseUrl: melioBaseUrl(),
      sonarPublishableKey: process.env.MELIO_SONAR_PUBLISHABLE_KEY?.trim() || null
    });
  });

  app.get('/api/melio/status', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      let apiOk = false;
      let partnerName: string | null = null;
      let apiError: string | null = null;
      if (isMelioConfigured()) {
        try {
          const health = await melioFetch<any>('/health');
          apiOk = true;
          partnerName = health?.partnerName || null;
        } catch (err: any) {
          apiError = err?.message || 'Could not reach Melio.';
        }
      }

      const integration = await loadIntegration(tenantId);
      let accounts: Array<{
        id: string;
        label: string;
        last4: string | null;
        isVerified: boolean;
        type: string | null;
      }> = [];
      let limitations: unknown = null;
      if (apiOk && integration?.entityId) {
        try {
          accounts = (await listAccounts(integration.entityId))
            .filter(isInternalAccount)
            .map((a) => ({
              id: a.id,
              label: accountLabel(a),
              last4: accountLast4(a),
              isVerified: a.isVerified !== false,
              type: a.type || null
            }));
        } catch (err) {
          console.warn('[melio] list accounts failed', err);
        }
        try {
          limitations = unwrap(
            await melioFetch<any>('/limitations', { entityId: integration.entityId })
          );
        } catch (err) {
          console.warn('[melio] limitations failed', err);
        }
      }

      res.json({
        configured: isMelioConfigured() && isFirebaseAdminConfigured(),
        environment: melioEnvironment(),
        apiOk,
        apiError,
        partnerName,
        connected: Boolean(integration?.entityId),
        entityId: integration?.entityId || null,
        entityName: integration?.entityName || null,
        kycStatus: integration?.kycStatus || null,
        fundingAccountId: integration?.fundingAccountId || null,
        fundingAccountLast4: integration?.fundingAccountLast4 || null,
        fundingAccountName: integration?.fundingAccountName || null,
        connectedAt: integration?.connectedAt || null,
        accounts,
        limitations,
        ready: Boolean(integration?.entityId && integration?.fundingAccountId)
      });
    })
  );

  /** Lightweight flag for Purchasing — office can pay bills but not manage Melio. */
  app.get('/api/melio/ready', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      res.json({
        ready:
          isMelioConfigured() &&
          Boolean(integration?.entityId && integration?.fundingAccountId),
        entityId: integration?.entityId || null
      });
    })
  );

  app.post('/api/melio/link-entity', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const entityIdInput = String(req.body?.entityId || '').trim();
      if (!tenantId || !entityIdInput) {
        res.status(400).json({ error: 'tenantId and entityId are required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const entity = unwrap<any>(
        await melioFetch<any>(`/entities/${encodeURIComponent(entityIdInput)}`)
      );
      const integration = await saveEntityLink(tenantId, uid, {
        ...entity,
        id: entity?.id || entityIdInput
      });
      res.json({ entityId: integration.entityId, kycStatus: integration.kycStatus });
    })
  );

  app.post('/api/melio/create-entity', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const b = req.body?.entity || {};
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      const required = [
        'legalName',
        'ein',
        'phoneNumber',
        'line1',
        'city',
        'state',
        'postalCode',
        'ownerFirstName',
        'ownerLastName',
        'ownerEmail',
        'ownerDateOfBirth'
      ];
      const missing = required.filter((k) => !String(b[k] || '').trim());
      if (missing.length) {
        res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
        return;
      }
      if (req.body?.termsAccepted !== true) {
        res.status(400).json({
          error:
            'The business owner must accept Melio’s Terms of Service before this business can be created.'
        });
        return;
      }
      const termsAcceptedAt = new Date().toISOString();
      const address = {
        line1: String(b.line1).trim(),
        city: String(b.city).trim(),
        state: String(b.state).trim().toUpperCase(),
        postalCode: String(b.postalCode).trim()
      };
      const body = {
        type: 'business',
        externalId: `tenant-${tenantId}`,
        name: String(b.name || b.legalName).trim(),
        legalName: String(b.legalName).trim(),
        phoneNumber: String(b.phoneNumber).trim(),
        businessType: String(b.businessType || 'llc').trim(),
        taxInfo: { type: 'ein', identifier: String(b.ein).trim() },
        industry: { naicsCode: String(b.naicsCode || '424930').trim() },
        contact: {
          firstName: String(b.ownerFirstName).trim(),
          lastName: String(b.ownerLastName).trim()
        },
        ...(b.website ? { website: String(b.website).trim() } : {}),
        address,
        legalAddress: address,
        owner: {
          firstName: String(b.ownerFirstName).trim(),
          lastName: String(b.ownerLastName).trim(),
          email: String(b.ownerEmail).trim(),
          dateOfBirth: String(b.ownerDateOfBirth).trim(),
          phoneNumber: String(b.ownerPhoneNumber || b.phoneNumber).trim()
        },
        termsAcceptance: {
          accepted: true,
          acceptedAt: termsAcceptedAt,
          version: MELIO_TERMS_VERSION
        }
      };
      const entity = unwrap<any>(
        await melioFetch<any>('/entities', {
          method: 'POST',
          body,
          idempotencyKey: `nos-entity-${tenantId}-${Date.now()}`,
          sonarToken: sonarTokenFrom(req)
        })
      );
      const integration = await saveEntityLink(tenantId, uid, entity, {
        version: MELIO_TERMS_VERSION,
        acceptedAt: termsAcceptedAt
      });
      res.json({ entityId: integration.entityId, kycStatus: integration.kycStatus });
    })
  );

  /** Melio-hosted Plaid page for linking the nursery's funding bank account. */
  app.post('/api/melio/funding-link', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      if (!integration?.entityId) {
        throw Object.assign(new Error('Link a Melio business first.'), { status: 400 });
      }
      const type = req.body?.type === 'card' ? 'card' : 'plaid';
      const link = unwrap<{ url?: string; expiration?: string }>(
        await melioFetch<any>('/accounts/link', {
          method: 'POST',
          entityId: integration.entityId,
          body: { type },
          idempotencyKey: `nos-link-${tenantId}-${Date.now()}`,
          sonarToken: sonarTokenFrom(req)
        })
      );
      if (!link?.url) {
        throw Object.assign(new Error('Melio did not return a link URL.'), { status: 502 });
      }
      res.json({ url: link.url, expiration: link.expiration || null });
    })
  );

  /** Melio-hosted Plaid verification for an unverified funding account. */
  app.post('/api/melio/verify-link', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const accountId = String(req.body?.accountId || '').trim();
      if (!tenantId || !accountId) {
        res.status(400).json({ error: 'tenantId and accountId are required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      if (!integration?.entityId) {
        throw Object.assign(new Error('Link a Melio business first.'), { status: 400 });
      }
      const link = unwrap<{ url?: string; expiration?: string }>(
        await melioFetch<any>(`/accounts/${encodeURIComponent(accountId)}/verify/link`, {
          method: 'POST',
          entityId: integration.entityId,
          body: {},
          idempotencyKey: `nos-verify-${accountId}-${Date.now()}`,
          sonarToken: sonarTokenFrom(req)
        })
      );
      if (!link?.url) {
        throw Object.assign(new Error('Melio did not return a verification link.'), {
          status: 502
        });
      }
      res.json({ url: link.url, expiration: link.expiration || null });
    })
  );

  app.post('/api/melio/select-funding', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const accountId = String(req.body?.accountId || '').trim();
      if (!tenantId || !accountId) {
        res.status(400).json({ error: 'tenantId and accountId are required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      if (!integration?.entityId) {
        throw Object.assign(new Error('Link a Melio business first.'), { status: 400 });
      }
      const account = (await listAccounts(integration.entityId)).find((a) => a.id === accountId);
      if (!account || !isInternalAccount(account)) {
        throw Object.assign(new Error('That funding account was not found in Melio.'), {
          status: 404
        });
      }
      if (account.isVerified === false) {
        throw Object.assign(
          new Error('That bank account is not verified yet. Finish verification in Melio first.'),
          { status: 400 }
        );
      }
      await integrationRef(tenantId).set(
        {
          fundingAccountId: account.id,
          fundingAccountLast4: accountLast4(account),
          fundingAccountName: accountLabel(account),
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
      res.json({ fundingAccountId: account.id });
    })
  );

  app.post('/api/melio/register-webhook', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const url = `${appOrigin()}/api/melio/webhook`;
      if (!url.startsWith('https://')) {
        throw Object.assign(new Error('Melio webhooks need an https APP_URL.'), { status: 400 });
      }
      await melioFetch<any>('/webhook', {
        method: 'PATCH',
        body: {
          url,
          description: 'NurseryOS',
          events: [
            'api.entity.updated',
            'api.account.created',
            'api.account.updated',
            'api.payment.created',
            'api.payment.updated'
          ],
          isActive: true
        }
      });
      res.json({ url });
    })
  );

  app.post('/api/melio/disconnect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      await integrationRef(tenantId).delete();
      res.json({ ok: true });
    })
  );

  app.post('/api/melio/quote-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const billIdsRaw = Array.isArray(req.body?.billIds) ? req.body.billIds : [];
      const billIds = [
        ...new Set(billIdsRaw.map((id: unknown) => String(id || '').trim()).filter(Boolean))
      ];
      if (!tenantId || billIds.length === 0) {
        res.status(400).json({ error: 'tenantId and billIds are required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);
      const prepared = await prepareMelioPayment(tenantId, billIds, sonarTokenFrom(req));
      const deductionDate = todayIsoDate();
      const [feeJson, etaJson] = await Promise.all([
        melioFetch<any>('/tools/fee-calculator', {
          method: 'POST',
          entityId: prepared.entityId,
          body: {
            originatingAccountId: prepared.fundingAccountId,
            receivingAccountId: prepared.receivingAccountId,
            deliveryPreference: 'standard-ach',
            amount: prepared.amountCents,
            currency: 'USD'
          }
        }),
        melioFetch<any>('/tools/delivery-eta', {
          method: 'POST',
          entityId: prepared.entityId,
          body: {
            originatingAccountId: prepared.fundingAccountId,
            receivingAccountId: prepared.receivingAccountId,
            amount: prepared.amountCents,
            deductionDate,
            currency: 'USD'
          }
        })
      ]);
      const fees = asList<{ amount?: number; chargeTo?: string }>(feeJson, 'fees');
      const feeCents = fees.reduce((sum, fee) => {
        if (fee.chargeTo && fee.chargeTo !== 'originator') return sum;
        const n = Number(fee.amount);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      const eta = unwrap<any>(etaJson);
      const estimates = Array.isArray(eta?.estimates) ? eta.estimates : [];
      const standard = estimates.find(
        (row: { deliveryPreference?: string }) => row.deliveryPreference === 'standard-ach'
      );
      res.json({
        amountCents: prepared.amountCents,
        feeCents,
        totalCents: prepared.amountCents + feeCents,
        deliveryDate: standard?.deliveryDate || null,
        deliveryPreference: 'standard-ach',
        vendorName: prepared.vendorName,
        last4: prepared.last4 || null,
        billCount: prepared.bills.length
      });
    })
  );

  app.post('/api/melio/pay-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const singleBillId = String(req.body?.billId || '').trim();
      const billIdsRaw = Array.isArray(req.body?.billIds) ? req.body.billIds : [];
      const billIds = [
        ...new Set(
          [singleBillId, ...billIdsRaw.map((id: unknown) => String(id || '').trim())].filter(
            Boolean
          )
        )
      ];
      if (!tenantId || billIds.length === 0) {
        res.status(400).json({ error: 'tenantId and billId(s) are required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);
      const prepared = await prepareMelioPayment(tenantId, billIds, sonarTokenFrom(req));
      const { bills, amountCents, receivingAccountId, last4, vendorName } = prepared;

      const billNumbers = bills
        .map((b) => String(b.data.billNumber || b.id).trim())
        .filter(Boolean)
        .slice(0, 6);
      const memo = (
        bills.length === 1
          ? `Bill ${billNumbers[0] || bills[0].id}`
          : `Bills ${billNumbers.join(', ')}${bills.length > billNumbers.length ? '…' : ''}`
      ).slice(0, 140);

      const body = {
        originatingAccountId: prepared.fundingAccountId,
        receivingAccountId,
        amount: amountCents,
        currency: 'USD',
        deductionDate: todayIsoDate(),
        deliveryPreference: 'standard-ach',
        compliance: { type: 'goods-and-services' },
        noteToRecipient: memo,
        noteToSelf: `NurseryOS ${memo}`.slice(0, 140)
      };
      const payment = unwrap<MelioPayment>(
        await melioFetch<any>('/payments', {
          method: 'POST',
          entityId: prepared.entityId,
          body: { ...body, metadata: { tenantId, billIds: billIds.join(',').slice(0, 450) } },
          idempotencyKey: `nos-pay-${crypto.randomUUID()}`,
          sonarToken: sonarTokenFrom(req)
        })
      );
      if (!payment?.id) {
        throw Object.assign(new Error('Melio did not return a payment id.'), { status: 502 });
      }

      const now = new Date().toISOString();
      const batch = getAdminDb().batch();
      for (const bill of bills) {
        batch.set(
          getAdminDb().doc(`tenants/${tenantId}/vendorBills/${bill.id}`),
          {
            status: 'payment_pending',
            paymentMethod: 'ach',
            paymentReference: payment.id,
            melioPaymentId: payment.id,
            melioPaymentStatus: payment.status || 'scheduled',
            melioAchLast4: last4 || null,
            melioPaymentError: null,
            updatedAt: now
          },
          { merge: true }
        );
      }
      await batch.commit();

      if (mapPaymentStatus(String(payment.status || '')) === 'paid') {
        await applyPaymentToAllBills(tenantId, payment);
      }

      res.json({
        paymentId: payment.id,
        status: payment.status || 'scheduled',
        amount: amountCents / 100,
        billIds,
        billCount: bills.length,
        vendorName,
        last4: last4 || null,
        provider: 'melio'
      });
    })
  );

  app.post('/api/melio/refresh-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = tenantIdFrom(req);
      const billId = String(req.body?.billId || '').trim();
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      if (!integration?.entityId) {
        throw Object.assign(new Error('Melio is not set up for this nursery.'), { status: 400 });
      }
      const billSnap = await getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`).get();
      if (!billSnap.exists) {
        throw Object.assign(new Error('Vendor bill not found.'), { status: 404 });
      }
      const paymentId = String(billSnap.data()?.melioPaymentId || '').trim();
      if (!paymentId) {
        throw Object.assign(new Error('This bill has no Melio payment to refresh.'), {
          status: 400
        });
      }
      const payment = unwrap<MelioPayment>(
        await melioFetch<any>(`/payments/${encodeURIComponent(paymentId)}`, {
          entityId: integration.entityId
        })
      );
      await applyPaymentToAllBills(tenantId, payment);
      res.json({ paymentId: payment.id, status: payment.status || null, provider: 'melio' });
    })
  );
}
