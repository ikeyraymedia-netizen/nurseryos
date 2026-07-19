import { createHmac, timingSafeEqual } from 'crypto';
import type { Express, Request, Response } from 'express';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

const INTUIT_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

type QbEnvironment = 'sandbox' | 'production';

interface QbIntegration {
  provider: 'quickbooks';
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  connectedAt: string;
  connectedByUserId: string;
  environment: QbEnvironment;
  updatedAt: string;
}

function qbEnv(): QbEnvironment {
  const raw = (process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox').toLowerCase();
  return raw === 'production' ? 'production' : 'sandbox';
}

function qbApiBase(): string {
  return qbEnv() === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function requireQbConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.QUICKBOOKS_REDIRECT_URI?.trim() ||
    (process.env.APP_URL
      ? `${process.env.APP_URL.replace(/\/$/, '')}/api/quickbooks/callback`
      : '');

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'QuickBooks is not configured. Set QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, and QUICKBOOKS_REDIRECT_URI (or APP_URL).'
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function appOrigin(): string {
  return (process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '');
}

function stateSecret(): string {
  return (
    process.env.QUICKBOOKS_STATE_SECRET?.trim() ||
    process.env.QUICKBOOKS_CLIENT_SECRET?.trim() ||
    'nurseryos-qb-state'
  );
}

function signState(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string): { tenantId: string; uid: string; exp: number } {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new Error('Invalid OAuth state.');
  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid OAuth state signature.');
  }
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
    tenantId: string;
    uid: string;
    exp: number;
  };
  if (!parsed.tenantId || !parsed.uid || !parsed.exp) {
    throw new Error('Invalid OAuth state payload.');
  }
  if (Date.now() > parsed.exp) {
    throw new Error('OAuth state expired. Try Connect again.');
  }
  return parsed;
}

function integrationRef(tenantId: string) {
  return getAdminDb().doc(`tenants/${tenantId}/integrations/quickbooks`);
}

async function readBearerUid(req: Request): Promise<string> {
  const header = req.headers.authorization || '';
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
    throw Object.assign(new Error('Only owners and admins can manage QuickBooks.'), {
      status: 403
    });
  }
}

async function assertCanPushInvoice(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office'])) {
    throw Object.assign(new Error('You do not have permission to sync invoices to QuickBooks.'), {
      status: 403
    });
  }
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function exchangeToken(params: URLSearchParams): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}> {
  const { clientId, clientSecret } = requireQbConfig();
  const res = await fetch(INTUIT_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || 'QuickBooks token exchange failed.');
  }
  return data;
}

async function loadIntegration(tenantId: string): Promise<QbIntegration | null> {
  const snap = await integrationRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() as QbIntegration;
}

async function getValidAccessToken(tenantId: string): Promise<{
  accessToken: string;
  realmId: string;
  integration: QbIntegration;
}> {
  const integration = await loadIntegration(tenantId);
  if (!integration?.accessToken || !integration.refreshToken || !integration.realmId) {
    throw Object.assign(new Error('QuickBooks is not connected for this nursery.'), {
      status: 400
    });
  }

  const skewMs = 60_000;
  if (Date.now() < integration.accessTokenExpiresAt - skewMs) {
    return {
      accessToken: integration.accessToken,
      realmId: integration.realmId,
      integration
    };
  }

  const refreshed = await exchangeToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: integration.refreshToken
    })
  );

  const next: QbIntegration = {
    ...integration,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || integration.refreshToken,
    accessTokenExpiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshTokenExpiresAt: refreshed.x_refresh_token_expires_in
      ? Date.now() + refreshed.x_refresh_token_expires_in * 1000
      : integration.refreshTokenExpiresAt,
    updatedAt: new Date().toISOString()
  };
  await integrationRef(tenantId).set(next, { merge: true });
  return { accessToken: next.accessToken, realmId: next.realmId, integration: next };
}

async function qboRequest<T>(
  tenantId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { accessToken, realmId } = await getValidAccessToken(tenantId);
  const url = `${qbApiBase()}/v3/company/${realmId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const detail =
      data?.Fault?.Error?.[0]?.Message ||
      data?.Fault?.Error?.[0]?.Detail ||
      data?.error ||
      `QuickBooks API error (${res.status})`;
    throw new Error(String(detail));
  }
  return data as T;
}

async function findOrCreateServiceItem(tenantId: string): Promise<string> {
  const query = encodeURIComponent(`select * from Item where Name = 'NurseryOS Line'`);
  const search = await qboRequest<any>(
    tenantId,
    'GET',
    `/query?query=${query}&minorversion=65`
  );
  const existing = search?.QueryResponse?.Item?.[0];
  if (existing?.Id) return String(existing.Id);

  const accounts = await qboRequest<any>(
    tenantId,
    'GET',
    `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}&minorversion=65`
  );
  const accountId = accounts?.QueryResponse?.Account?.[0]?.Id;
  if (!accountId) {
    throw new Error(
      'QuickBooks needs an Income account to create line items. Add one in QBO, then retry.'
    );
  }

  const created = await qboRequest<any>(tenantId, 'POST', '/item?minorversion=65', {
    Name: 'NurseryOS Line',
    Type: 'Service',
    IncomeAccountRef: { value: String(accountId) }
  });
  const id = created?.Item?.Id;
  if (!id) throw new Error('Could not create a QuickBooks service item for line mapping.');
  return String(id);
}

async function findOrCreateCustomer(
  tenantId: string,
  doc: Record<string, any>
): Promise<string> {
  const displayName = String(doc.billToName || doc.customerName || 'Customer').slice(0, 100);
  const query = encodeURIComponent(
    `select * from Customer where DisplayName = '${displayName.replace(/'/g, "\\'")}'`
  );
  const search = await qboRequest<any>(
    tenantId,
    'GET',
    `/query?query=${query}&minorversion=65`
  );
  const existing = search?.QueryResponse?.Customer?.[0];
  if (existing?.Id) return String(existing.Id);

  const created = await qboRequest<any>(tenantId, 'POST', '/customer?minorversion=65', {
    DisplayName: displayName,
    CompanyName: displayName,
    PrimaryEmailAddr: doc.customerEmail ? { Address: doc.customerEmail } : undefined,
    BillAddr: doc.billToAddress
      ? { Line1: String(doc.billToAddress).slice(0, 500) }
      : undefined
  });
  const id = created?.Customer?.Id;
  if (!id) throw new Error('QuickBooks did not return a customer id.');
  return String(id);
}

function mapDocToInvoice(
  doc: Record<string, any>,
  customerRefId: string,
  itemRefId: string
) {
  const lines = (Array.isArray(doc.items) ? doc.items : []).map((item: any, index: number) => {
    const qty = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const desc = [item.plantName, item.containerSize].filter(Boolean).join(' — ');
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: Number((qty * unitPrice).toFixed(2)),
      Description: desc || `Line ${index + 1}`,
      SalesItemLineDetail: {
        ItemRef: { value: itemRefId },
        Qty: qty,
        UnitPrice: unitPrice
      }
    };
  });

  const freight = Number(doc.freightCharge) || 0;
  if (freight > 0) {
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(freight.toFixed(2)),
      Description: 'Freight / Delivery',
      SalesItemLineDetail: {
        ItemRef: { value: itemRefId },
        Qty: 1,
        UnitPrice: freight
      }
    });
  }

  return {
    DocNumber: String(doc.documentNumber || '').slice(0, 21) || undefined,
    TxnDate: String(doc.documentDate || new Date().toISOString()).slice(0, 10),
    DueDate: doc.dueDate ? String(doc.dueDate).slice(0, 10) : undefined,
    PrivateNote: doc.notes ? String(doc.notes).slice(0, 4000) : undefined,
    CustomerRef: { value: customerRefId },
    Line: lines,
    CustomerMemo: doc.paymentTerms
      ? { value: `Terms: ${doc.paymentTerms}` }
      : undefined
  };
}

function httpError(res: Response, err: any) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[quickbooks]', err);
  res.status(status).json({
    error: err?.message || 'QuickBooks request failed.'
  });
}

async function withAuth(
  req: Request,
  res: Response,
  fn: (uid: string) => Promise<void>
) {
  try {
    const uid = await readBearerUid(req);
    await fn(uid);
  } catch (err: any) {
    httpError(res, err);
  }
}

export function isQuickbooksConfigured(): boolean {
  try {
    requireQbConfig();
    return true;
  } catch {
    return false;
  }
}

export function registerQuickbooksRoutes(app: Express) {
  app.get('/api/quickbooks/config-status', (_req, res) => {
    const quickbooks = isQuickbooksConfigured();
    const firebaseAdmin = isFirebaseAdminConfigured();
    res.json({
      configured: quickbooks && firebaseAdmin,
      quickbooks,
      firebaseAdmin,
      environment: qbEnv()
    });
  });

  app.get('/api/quickbooks/status', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.query.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      res.json({
        connected: Boolean(integration?.realmId && integration?.refreshToken),
        realmId: integration?.realmId || null,
        connectedAt: integration?.connectedAt || null,
        environment: integration?.environment || qbEnv(),
        configured: isQuickbooksConfigured() && isFirebaseAdminConfigured()
      });
    })
  );

  app.post('/api/quickbooks/connect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const { clientId, redirectUri } = requireQbConfig();
      const state = signState({
        tenantId,
        uid,
        exp: Date.now() + 15 * 60 * 1000
      });
      const url = new URL(INTUIT_AUTHORIZE);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', QBO_SCOPE);
      url.searchParams.set('state', state);
      res.json({ authorizeUrl: url.toString() });
    })
  );

  app.get('/api/quickbooks/callback', async (req, res) => {
    try {
      const code = String(req.query.code || '');
      const state = String(req.query.state || '');
      const realmId = String(req.query.realmId || '');
      const error = String(req.query.error || '');
      if (error) {
        res.redirect(`${appOrigin()}/?qb=error&message=${encodeURIComponent(error)}`);
        return;
      }
      if (!code || !state || !realmId) {
        res.redirect(`${appOrigin()}/?qb=error&message=${encodeURIComponent('Missing OAuth fields')}`);
        return;
      }

      const { tenantId, uid } = verifyState(state);
      await assertAdminOrOwner(tenantId, uid);
      const { redirectUri } = requireQbConfig();
      const token = await exchangeToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        })
      );

      const now = new Date().toISOString();
      const doc: QbIntegration = {
        provider: 'quickbooks',
        realmId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
        refreshTokenExpiresAt: token.x_refresh_token_expires_in
          ? Date.now() + token.x_refresh_token_expires_in * 1000
          : undefined,
        connectedAt: now,
        connectedByUserId: uid,
        environment: qbEnv(),
        updatedAt: now
      };
      await integrationRef(tenantId).set(doc, { merge: true });
      res.redirect(`${appOrigin()}/?qb=connected`);
    } catch (err: any) {
      console.error('[quickbooks] callback failed', err);
      res.redirect(
        `${appOrigin()}/?qb=error&message=${encodeURIComponent(err?.message || 'Connect failed')}`
      );
    }
  });

  app.post('/api/quickbooks/disconnect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      await integrationRef(tenantId).delete();
      res.json({ success: true });
    })
  );

  app.post('/api/quickbooks/push-invoice', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const documentId = String(req.body?.documentId || '');
      if (!tenantId || !documentId) {
        res.status(400).json({ error: 'tenantId and documentId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
      const snap = await docRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Invoice/estimate document not found.' });
        return;
      }
      const doc = snap.data() || {};
      if (doc.type !== 'invoice' && doc.type !== 'estimate') {
        res.status(400).json({ error: 'Only invoices and estimates can be synced.' });
        return;
      }

      const customerRefId = await findOrCreateCustomer(tenantId, doc);
      const itemRefId = await findOrCreateServiceItem(tenantId);
      const payload = mapDocToInvoice(doc, customerRefId, itemRefId);
      const endpoint = doc.type === 'estimate' ? '/estimate' : '/invoice';
      const created = await qboRequest<any>(
        tenantId,
        'POST',
        `${endpoint}?minorversion=65`,
        payload
      );
      const entity = doc.type === 'estimate' ? created?.Estimate : created?.Invoice;
      const qboId = entity?.Id ? String(entity.Id) : null;
      if (!qboId) {
        throw new Error('QuickBooks did not return a document id.');
      }

      await docRef.set(
        {
          qboInvoiceId: qboId,
          qboDocType: doc.type,
          qboSyncedAt: new Date().toISOString(),
          qboSyncedByUserId: uid,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

      res.json({
        success: true,
        qboInvoiceId: qboId,
        qboDocType: doc.type
      });
    })
  );
}
