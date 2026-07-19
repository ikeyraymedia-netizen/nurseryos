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

function qbAppBase(env?: QbEnvironment): string {
  return (env || qbEnv()) === 'production'
    ? 'https://app.qbo.intuit.com'
    : 'https://app.sandbox.qbo.intuit.com';
}

function qbTxnOpenUrl(
  env: QbEnvironment | undefined,
  docType: 'invoice' | 'estimate',
  txnId: string,
  realmId?: string | null
): string {
  const path = docType === 'estimate' ? 'estimate' : 'invoice';
  const base = qbAppBase(env);
  // Include company switch so the browser opens the connected realm, not whatever
  // company the user last viewed (otherwise txnId can show a totally different invoice).
  if (realmId) {
    const navigationURL = `${path}?txnId=${encodeURIComponent(txnId)}`;
    return `${base}/app/switchCompany?companyId=${encodeURIComponent(
      realmId
    )}&navigationURL=${encodeURIComponent(navigationURL)}`;
  }
  return `${base}/app/${path}?txnId=${encodeURIComponent(txnId)}`;
}

function escapeQboQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sizeToQbNameSuffix(containerSize: string): string[] {
  const size = String(containerSize || '').trim();
  const out: string[] = [];
  if (!size) return out;
  out.push(size);
  const hash = size.match(/^#(\d+)$/);
  if (hash) {
    out.push(`${hash[1]} gal.`);
    out.push(`${hash[1]} gal`);
    out.push(`${hash[1]}g`);
  }
  if (/^b\s*&\s*b$/i.test(size)) out.push('B&B');
  if (/^tray$/i.test(size)) {
    out.push('18ct. Flat');
    out.push('Flat');
  }
  if (/"$/.test(size)) out.push(size);
  return [...new Set(out)];
}

async function findItemRefForLine(
  tenantId: string,
  plantName: string,
  containerSize: string,
  fallbackItemId: string
): Promise<string> {
  const plant = String(plantName || '').trim();
  if (!plant) return fallbackItemId;

  const candidates: string[] = [];
  for (const suffix of sizeToQbNameSuffix(containerSize)) {
    candidates.push(`${plant} ${suffix}`);
  }
  candidates.push(plant);

  for (const name of candidates) {
    try {
      const query = encodeURIComponent(
        `select * from Item where Name = '${escapeQboQueryValue(name)}' MAXRESULTS 1`
      );
      const search = await qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${query}&minorversion=65`
      );
      const existing = search?.QueryResponse?.Item?.[0];
      if (existing?.Id) return String(existing.Id);
    } catch {
      // try next candidate
    }
  }
  return fallbackItemId;
}

async function fetchCompanyName(tenantId: string, realmId: string): Promise<string | null> {
  try {
    const info = await qboRequest<any>(
      tenantId,
      'GET',
      `/companyinfo/${realmId}?minorversion=65`
    );
    return info?.CompanyInfo?.CompanyName || info?.CompanyInfo?.LegalName || null;
  } catch {
    return null;
  }
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
): Promise<{ id: string; displayName: string }> {
  const displayName = String(doc.billToName || doc.customerName || '')
    .trim()
    .slice(0, 100);
  if (!displayName) {
    throw Object.assign(new Error('Invoice is missing bill-to / customer name.'), {
      status: 400
    });
  }

  const query = encodeURIComponent(
    `select * from Customer where DisplayName = '${escapeQboQueryValue(displayName)}' MAXRESULTS 1`
  );
  try {
    const search = await qboRequest<any>(
      tenantId,
      'GET',
      `/query?query=${query}&minorversion=65`
    );
    const existing = search?.QueryResponse?.Customer?.[0];
    if (existing?.Id) {
      return { id: String(existing.Id), displayName: String(existing.DisplayName || displayName) };
    }
  } catch {
    // Fall through to create
  }

  const created = await qboRequest<any>(tenantId, 'POST', '/customer?minorversion=65', {
    DisplayName: displayName,
    CompanyName: displayName,
    PrimaryEmailAddr: doc.customerEmail ? { Address: String(doc.customerEmail) } : undefined,
    BillAddr: doc.billToAddress
      ? { Line1: String(doc.billToAddress).slice(0, 500) }
      : undefined
  });
  const id = created?.Customer?.Id;
  if (!id) throw new Error('QuickBooks did not return a customer id.');
  return { id: String(id), displayName };
}

async function mapDocToInvoice(
  tenantId: string,
  doc: Record<string, any>,
  customerRefId: string,
  fallbackItemId: string
) {
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  if (rawItems.length === 0) {
    throw Object.assign(
      new Error(
        'This invoice has no plant line items saved. Save the invoice to the customer again, then push.'
      ),
      { status: 400 }
    );
  }

  const lines = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    const plantName = String(item.plantName || item.name || '').trim();
    const containerSize = String(item.containerSize || item.size || '').trim();
    const qty = Number(item.quantity ?? item.qty) || 0;
    const unitPrice = Number(item.unitPrice ?? item.price) || 0;
    if (!plantName && qty === 0 && unitPrice === 0) continue;

    const itemRefId = await findItemRefForLine(
      tenantId,
      plantName || `Line ${index + 1}`,
      containerSize,
      fallbackItemId
    );
    const desc = [plantName || `Line ${index + 1}`, containerSize].filter(Boolean).join(' — ');
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number((Math.max(qty, 1) * unitPrice).toFixed(2)),
      Description: desc,
      SalesItemLineDetail: {
        ItemRef: { value: itemRefId },
        Qty: Math.max(qty, 1),
        UnitPrice: unitPrice
      }
    });
  }

  const freight = Number(doc.freightCharge) || 0;
  if (freight > 0) {
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(freight.toFixed(2)),
      Description: 'Freight / Delivery',
      SalesItemLineDetail: {
        ItemRef: { value: fallbackItemId },
        Qty: 1,
        UnitPrice: freight
      }
    });
  }

  if (lines.length === 0) {
    throw Object.assign(
      new Error('No usable plant lines found on this invoice. Re-save it, then push again.'),
      { status: 400 }
    );
  }

  return {
    DocNumber: String(doc.documentNumber || '').slice(0, 21) || undefined,
    TxnDate: String(doc.documentDate || new Date().toISOString()).slice(0, 10),
    DueDate: doc.dueDate ? String(doc.dueDate).slice(0, 10) : undefined,
    PrivateNote: [
      doc.notes ? String(doc.notes) : '',
      `NurseryOS ${doc.type || 'invoice'} ${doc.documentNumber || ''}`.trim()
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000),
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
    let redirectUri: string | null = null;
    try {
      redirectUri = requireQbConfig().redirectUri;
    } catch {
      redirectUri = null;
    }
    res.json({
      configured: quickbooks && firebaseAdmin,
      quickbooks,
      firebaseAdmin,
      redirectUri,
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
      const connected = Boolean(integration?.realmId && integration?.refreshToken);
      let companyName: string | null = null;
      if (connected) {
        try {
          const info = await qboRequest<any>(
            tenantId,
            'GET',
            `/companyinfo/${integration!.realmId}?minorversion=65`
          );
          companyName =
            info?.CompanyInfo?.CompanyName ||
            info?.CompanyInfo?.LegalName ||
            null;
        } catch {
          companyName = null;
        }
      }
      res.json({
        connected,
        realmId: integration?.realmId || null,
        connectedAt: integration?.connectedAt || null,
        environment: integration?.environment || qbEnv(),
        configured: isQuickbooksConfigured() && isFirebaseAdminConfigured(),
        companyName
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

      const customer = await findOrCreateCustomer(tenantId, doc);
      const itemRefId = await findOrCreateServiceItem(tenantId);
      const payload = await mapDocToInvoice(tenantId, doc, customer.id, itemRefId);
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

      const integration = await loadIntegration(tenantId);
      const env = integration?.environment || qbEnv();
      const companyName = integration?.realmId
        ? await fetchCompanyName(tenantId, integration.realmId)
        : null;

      let verifiedCustomer = customer.displayName;
      let totalAmt: number | null = null;
      let lineCount = 0;
      let linePreview: string[] = [];
      let verified = false;
      try {
        const checkPath =
          doc.type === 'estimate'
            ? `/estimate/${qboId}?minorversion=65`
            : `/invoice/${qboId}?minorversion=65`;
        const check = await qboRequest<any>(tenantId, 'GET', checkPath);
        const checked = doc.type === 'estimate' ? check?.Estimate : check?.Invoice;
        verified = Boolean(checked?.Id);
        if (checked?.CustomerRef?.name) verifiedCustomer = String(checked.CustomerRef.name);
        if (checked?.TotalAmt != null) totalAmt = Number(checked.TotalAmt);
        const checkedLines = Array.isArray(checked?.Line) ? checked.Line : [];
        lineCount = checkedLines.filter((l: any) => l?.DetailType === 'SalesItemLineDetail').length;
        linePreview = checkedLines
          .filter((l: any) => l?.DetailType === 'SalesItemLineDetail')
          .slice(0, 5)
          .map((l: any) => String(l.Description || l.SalesItemLineDetail?.ItemRef?.name || 'Line'));
      } catch {
        verified = false;
      }

      if (verified && lineCount === 0) {
        throw new Error(
          'QuickBooks created an invoice with no plant lines. Re-save the NurseryOS invoice (with prices), then push again.'
        );
      }

      const openUrl = qbTxnOpenUrl(env, doc.type, qboId, integration?.realmId);

      await docRef.set(
        {
          qboInvoiceId: qboId,
          qboDocType: doc.type,
          qboDocNumber: entity?.DocNumber ? String(entity.DocNumber) : null,
          qboOpenUrl: openUrl,
          qboSyncedAt: new Date().toISOString(),
          qboSyncedByUserId: uid,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

      res.json({
        success: true,
        qboInvoiceId: qboId,
        qboDocType: doc.type,
        qboDocNumber: entity?.DocNumber ? String(entity.DocNumber) : null,
        customerName: verifiedCustomer,
        totalAmt,
        lineCount,
        linePreview,
        environment: env,
        companyName,
        verified,
        openUrl,
        sandboxUrl: env === 'sandbox' ? `${qbAppBase('sandbox')}/app/invoices` : null
      });
    })
  );

  // List recent invoices in the connected QBO company (debug / find-what-was-pushed)
  app.get('/api/quickbooks/recent-invoices', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.query.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      if (!integration?.realmId) {
        res.status(400).json({ error: 'QuickBooks is not connected.' });
        return;
      }
      const env = integration.environment || qbEnv();
      const companyName = await fetchCompanyName(tenantId, integration.realmId);
      const result = await qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${encodeURIComponent(
          'SELECT Id, DocNumber, TxnDate, TotalAmt, CustomerRef FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 10'
        )}&minorversion=65`
      );
      const invoices = (result?.QueryResponse?.Invoice || []).map((inv: any) => ({
        id: String(inv.Id),
        docNumber: inv.DocNumber ? String(inv.DocNumber) : null,
        txnDate: inv.TxnDate ? String(inv.TxnDate) : null,
        totalAmt: inv.TotalAmt != null ? Number(inv.TotalAmt) : null,
        customerName: inv.CustomerRef?.name ? String(inv.CustomerRef.name) : null,
        openUrl: qbTxnOpenUrl(env, 'invoice', String(inv.Id), integration.realmId)
      }));
      res.json({
        environment: env,
        companyName,
        realmId: integration.realmId,
        invoices
      });
    })
  );
}
