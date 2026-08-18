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
  if (!hasAnyRole(roles, ['owner', 'admin', 'office', 'sales'])) {
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
    const fault = data?.Fault?.Error?.[0];
    // QBO often puts a generic Message ("Invalid String") but the useful part
    // (which field is bad) is in Detail — surface both so errors are diagnosable.
    const message = fault?.Message ? String(fault.Message) : '';
    const detail = fault?.Detail ? String(fault.Detail) : '';
    const code = fault?.code != null ? `code ${fault.code}` : '';
    const element = fault?.element ? `field ${fault.element}` : '';
    const combined = [message, detail, code, element].filter(Boolean).join(' — ');
    const errMessage =
      combined || data?.error || `QuickBooks API error (${res.status})`;
    const err: any = new Error(String(errMessage));
    err.status = res.status;
    if (fault?.code != null) err.qboCode = String(fault.code);
    throw err;
  }
  return data as T;
}

function isQboMissingError(err: any): boolean {
  const code = String(err?.qboCode || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    err?.status === 404 ||
    code === '610' ||
    code === '2500' ||
    msg.includes('object not found') ||
    msg.includes('does not exist')
  );
}

type QboTxnKind = 'invoice' | 'estimate' | 'credit_memo' | 'bill';

function qboTxnSpec(kind: QboTxnKind): { path: string; entity: string; ui: string } {
  switch (kind) {
    case 'estimate':
      return { path: 'estimate', entity: 'Estimate', ui: 'estimate' };
    case 'credit_memo':
      return { path: 'creditmemo', entity: 'CreditMemo', ui: 'creditmemo' };
    case 'bill':
      return { path: 'bill', entity: 'Bill', ui: 'bill' };
    default:
      return { path: 'invoice', entity: 'Invoice', ui: 'invoice' };
  }
}

function salesDocKind(type: unknown): 'invoice' | 'estimate' | 'credit_memo' | null {
  if (type === 'invoice' || type === 'estimate' || type === 'credit_memo') return type;
  return null;
}

async function getQboTxn(
  tenantId: string,
  docType: QboTxnKind,
  qboId: string
): Promise<any | null> {
  const spec = qboTxnSpec(docType);
  const extra = docType === 'invoice' ? '&include=invoiceLink' : '';
  const path = `/${spec.path}/${encodeURIComponent(qboId)}?minorversion=65${extra}`;
  try {
    const check = await qboRequest<any>(tenantId, 'GET', path);
    const entity = check?.[spec.entity];
    return entity?.Id ? entity : null;
  } catch (err) {
    if (isQboMissingError(err)) return null;
    throw err;
  }
}

async function getQboSalesTxn(
  tenantId: string,
  docType: 'invoice' | 'estimate' | 'credit_memo',
  qboId: string
): Promise<any | null> {
  return getQboTxn(tenantId, docType, qboId);
}

async function deleteQboTxn(
  tenantId: string,
  docType: QboTxnKind,
  qboId: string
): Promise<{ deleted: boolean; voided?: boolean; alreadyGone?: boolean }> {
  const existing = await getQboTxn(tenantId, docType, qboId);
  if (!existing) return { deleted: false, alreadyGone: true };

  const spec = qboTxnSpec(docType);
  const body = {
    Id: String(existing.Id),
    SyncToken: String(existing.SyncToken ?? '0')
  };

  try {
    await qboRequest<any>(
      tenantId,
      'POST',
      `/${spec.path}?operation=delete&minorversion=65`,
      body
    );
    return { deleted: true };
  } catch (err) {
    if (isQboMissingError(err)) return { deleted: false, alreadyGone: true };
    if (docType === 'estimate') throw err;
    try {
      const latest = (await getQboTxn(tenantId, docType, qboId)) || existing;
      await qboRequest<any>(
        tenantId,
        'POST',
        `/${spec.path}?operation=void&minorversion=65`,
        {
          Id: String(latest.Id),
          SyncToken: String(latest.SyncToken ?? body.SyncToken)
        }
      );
      return { deleted: false, voided: true };
    } catch (voidErr) {
      if (isQboMissingError(voidErr)) return { deleted: false, alreadyGone: true };
      throw err;
    }
  }
}

function qbAppBase(env?: QbEnvironment): string {
  return (env || qbEnv()) === 'production'
    ? 'https://app.qbo.intuit.com'
    : 'https://app.sandbox.qbo.intuit.com';
}

function qbTxnOpenUrl(
  env: QbEnvironment | undefined,
  docType: QboTxnKind,
  txnId: string,
  realmId?: string | null
): string {
  const path = qboTxnSpec(docType).ui;
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

/**
 * QuickBooks rejects strings with control characters or certain non-ASCII
 * symbols ("Invalid String. The String may contain unsupported or illegal
 * chars."). Strip control chars, normalize common typographic characters to
 * plain ASCII, and drop anything outside the safe printable range.
 */
function sanitizeQbString(value: unknown, maxLen = 4000): string {
  let out = String(value ?? '');
  // Normalize common “smart” punctuation and symbols to ASCII equivalents.
  out = out
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2022\u00B7\u2043\u2219]/g, '-')
    .replace(/\u2026/g, '...');
  // Remove control characters except tab / newline / carriage return.
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Drop any remaining characters outside the basic printable ASCII range.
  out = out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return out.trim().slice(0, maxLen);
}

/**
 * QuickBooks names (Customer DisplayName / CompanyName, Item Name) additionally
 * forbid a colon — it's reserved as the parent:sub-customer / sub-item
 * separator — and can't contain tabs/newlines. Apply the general string
 * sanitizer, then strip those reserved characters so names never trigger
 * "Element contains invalid characters".
 */
function sanitizeQbName(value: unknown, maxLen = 100): string {
  return sanitizeQbString(value, maxLen)
    .replace(/[:\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sizeToQbNameSuffix(containerSize: string): string[] {
  const size = String(containerSize || '').trim();
  const out: string[] = [];
  if (!size) return out;
  const hash = size.match(/^#(\d+)$/);
  if (hash) {
    // Prefer QuickBooks product-list style names first
    out.push(`${hash[1]} gal.`);
    out.push(`${hash[1]} gal`);
    out.push(size);
    out.push(`${hash[1]}g`);
  } else if (/^b\s*&\s*b$/i.test(size)) {
    out.push('B&B');
  } else if (/^tray$/i.test(size)) {
    out.push('18ct. Flat');
    out.push('Flat');
    out.push('Tray');
  } else if (/"$/.test(size)) {
    out.push(size);
  } else {
    out.push(size);
  }
  return [...new Set(out)];
}

function preferredQbItemName(plantName: string, containerSize: string): string {
  const plant = String(plantName || '').trim() || 'Plant';
  const suffix = sizeToQbNameSuffix(containerSize)[0];
  const full = suffix ? `${plant} ${suffix}` : plant;
  // Item Name can't contain a colon (sub-item separator) or control chars.
  return sanitizeQbName(full, 100) || 'Plant';
}

async function getIncomeAccountId(tenantId: string): Promise<string> {
  const accounts = await qboRequest<any>(
    tenantId,
    'GET',
    `/query?query=${encodeURIComponent(
      "SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1"
    )}&minorversion=65`
  );
  const accountId = accounts?.QueryResponse?.Account?.[0]?.Id;
  if (!accountId) {
    throw new Error(
      'QuickBooks needs an Income account to create products. Add one in QBO, then retry.'
    );
  }
  return String(accountId);
}

/** Expense / COGS account for vendor bill lines (AccountBasedExpenseLineDetail). */
async function getExpenseAccountId(tenantId: string): Promise<string> {
  const queries = [
    "SELECT * FROM Account WHERE AccountType = 'Cost of Goods Sold' AND Active = true MAXRESULTS 5",
    "SELECT * FROM Account WHERE AccountSubType = 'SuppliesMaterialsCogs' AND Active = true MAXRESULTS 5",
    "SELECT * FROM Account WHERE AccountType = 'Expense' AND Active = true MAXRESULTS 5"
  ];
  for (const q of queries) {
    try {
      const accounts = await qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${encodeURIComponent(q)}&minorversion=65`
      );
      const list = accounts?.QueryResponse?.Account || [];
      const preferred =
        list.find((a: any) => /cost of goods|cogs|plants|supplies|inventory/i.test(String(a.Name || ''))) ||
        list[0];
      if (preferred?.Id) return String(preferred.Id);
    } catch {
      // try next query
    }
  }
  throw new Error(
    'QuickBooks needs a Cost of Goods Sold or Expense account to push vendor bills. Add one in QBO, then retry.'
  );
}

async function findOrCreateVendor(
  tenantId: string,
  vendor: {
    id?: string;
    name?: string;
    contactEmail?: string;
    phone?: string;
    billingAddress?: string;
    qboVendorId?: string | null;
  }
): Promise<{ id: string; displayName: string }> {
  const displayName = sanitizeQbName(vendor.name || '', 100);
  if (!displayName) {
    throw Object.assign(new Error('Vendor is missing a name.'), { status: 400 });
  }

  const existingQboId = String(vendor.qboVendorId || '').trim();
  if (existingQboId) {
    try {
      const check = await qboRequest<any>(
        tenantId,
        'GET',
        `/vendor/${existingQboId}?minorversion=65`
      );
      if (check?.Vendor?.Id) {
        return {
          id: String(check.Vendor.Id),
          displayName: String(check.Vendor.DisplayName || displayName)
        };
      }
    } catch {
      // fall through to lookup / create
    }
  }

  const query = encodeURIComponent(
    `select * from Vendor where DisplayName = '${escapeQboQueryValue(displayName)}' MAXRESULTS 1`
  );
  try {
    const search = await qboRequest<any>(
      tenantId,
      'GET',
      `/query?query=${query}&minorversion=65`
    );
    const existing = search?.QueryResponse?.Vendor?.[0];
    if (existing?.Id) {
      return { id: String(existing.Id), displayName: String(existing.DisplayName || displayName) };
    }
  } catch {
    // Fall through to create
  }

  const vendorPayload: Record<string, unknown> = {
    DisplayName: displayName,
    CompanyName: displayName
  };
  if (vendor.contactEmail) {
    vendorPayload.PrimaryEmailAddr = { Address: String(vendor.contactEmail).slice(0, 100) };
  }
  if (vendor.phone) {
    vendorPayload.PrimaryPhone = { FreeFormNumber: String(vendor.phone).slice(0, 30) };
  }
  if (vendor.billingAddress) {
    vendorPayload.BillAddr = { Line1: sanitizeQbString(vendor.billingAddress, 500) };
  }
  const created = await qboRequest<any>(
    tenantId,
    'POST',
    '/vendor?minorversion=65',
    vendorPayload
  );
  const id = created?.Vendor?.Id;
  if (!id) throw new Error('QuickBooks did not return a vendor id.');
  return { id: String(id), displayName };
}

function toQboDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function mapVendorBillToQboBill(params: {
  bill: Record<string, any>;
  vendorRefId: string;
  expenseAccountId: string;
}) {
  const { bill, vendorRefId, expenseAccountId } = params;
  const rawItems = Array.isArray(bill.items) ? bill.items : [];
  const lines: any[] = [];

  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    const plantName = sanitizeQbString(item.plantName || item.name || '', 4000);
    const containerSize = sanitizeQbString(item.containerSize || item.size || '', 100);
    const qty = Number(item.quantity ?? item.qty) || 0;
    const unitCost = Number(item.unitCost ?? item.cost ?? item.unitPrice) || 0;
    const amount = Math.round(qty * unitCost * 100) / 100;
    // Account-based expense lines need a positive Amount; qty/unit belong in Description only.
    if (!(amount > 0)) continue;

    const category = sanitizeQbString(item.category || '', 100);
    const descParts = [plantName, containerSize ? `(${containerSize})` : '', category ? `- ${category}` : '']
      .filter(Boolean)
      .join(' ');
    const description = sanitizeQbString(
      qty > 0
        ? `${descParts || `Line ${index + 1}`} - ${qty} @ $${unitCost.toFixed(2)}`
        : descParts || `Line ${index + 1}`,
      4000
    );

    lines.push({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: amount,
      Description: description,
      // Do NOT send Qty/UnitPrice here — QBO rejects them on AccountBasedExpenseLineDetail.
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId }
      }
    });
  }

  const freight = Number(bill.freightCharge) || 0;
  if (freight > 0) {
    lines.push({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: Math.round(freight * 100) / 100,
      Description: 'Freight',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId }
      }
    });
  }

  if (lines.length === 0) {
    const total = Number(bill.grandTotal) || Number(bill.subtotal) || 0;
    if (!(total > 0)) {
      throw Object.assign(
        new Error('This bill has no line items or total to push to QuickBooks.'),
        { status: 400 }
      );
    }
    lines.push({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: Math.round(total * 100) / 100,
      Description: sanitizeQbString(bill.notes || bill.billNumber || 'Vendor bill', 4000),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId }
      }
    });
  }

  const docNumber = sanitizeQbString(
    bill.vendorInvoiceNumber || bill.billNumber || '',
    21
  );
  const noteParts = [
    bill.billNumber ? `NurseryOS ${bill.billNumber}` : null,
    bill.poNumber ? `PO ${bill.poNumber}` : null,
    bill.notes ? String(bill.notes) : null
  ].filter(Boolean);
  const txnDate = toQboDate(bill.billDate) || new Date().toISOString().slice(0, 10);
  const dueDate = toQboDate(bill.dueDate);

  return {
    VendorRef: { value: vendorRefId },
    TxnDate: txnDate,
    ...(dueDate ? { DueDate: dueDate } : {}),
    ...(docNumber ? { DocNumber: docNumber } : {}),
    ...(noteParts.length
      ? { PrivateNote: sanitizeQbString(noteParts.join(' - '), 4000) }
      : {}),
    Line: lines
  };
}

async function findItemByExactName(tenantId: string, name: string): Promise<string | null> {
  const query = encodeURIComponent(
    `select * from Item where Name = '${escapeQboQueryValue(name)}' MAXRESULTS 1`
  );
  const search = await qboRequest<any>(
    tenantId,
    'GET',
    `/query?query=${query}&minorversion=65`
  );
  const existing = search?.QueryResponse?.Item?.[0];
  return existing?.Id ? String(existing.Id) : null;
}

/**
 * Use a real Product/Service per plant (so QBO Product column shows the plant name),
 * matching existing QB catalog names when possible, otherwise creating a Service item.
 */
async function findOrCreateItemForLine(
  tenantId: string,
  plantName: string,
  containerSize: string,
  incomeAccountId: string
): Promise<string> {
  const plant = String(plantName || '').trim();
  if (!plant) {
    throw new Error('Invoice line is missing a plant name.');
  }

  const candidates: string[] = [];
  for (const suffix of sizeToQbNameSuffix(containerSize)) {
    candidates.push(`${plant} ${suffix}`);
  }
  candidates.push(plant);

  for (const name of candidates) {
    try {
      const id = await findItemByExactName(tenantId, name.slice(0, 100));
      if (id) return id;
    } catch {
      // try next
    }
  }

  const createName = preferredQbItemName(plant, containerSize);
  // If create name was already tried and missing, create it now.
  try {
    const existing = await findItemByExactName(tenantId, createName);
    if (existing) return existing;
  } catch {
    // continue to create
  }

  const created = await qboRequest<any>(tenantId, 'POST', '/item?minorversion=65', {
    Name: createName,
    Type: 'Service',
    IncomeAccountRef: { value: incomeAccountId }
  });
  const id = created?.Item?.Id;
  if (!id) {
    throw new Error(`Could not create QuickBooks product “${createName}”.`);
  }
  return String(id);
}

/**
 * QuickBooks Online has no native PO field on invoices — the "P.O. Number" that
 * appears on sales forms is a company-defined sales custom field. Look it up so we
 * can populate the matching CustomField (DefinitionId 1-3) on the transaction.
 */
async function getPoCustomFieldDefinition(
  tenantId: string
): Promise<{ definitionId: string; name: string } | null> {
  try {
    const prefs = await qboRequest<any>(
      tenantId,
      'GET',
      `/query?query=${encodeURIComponent('select * from Preferences')}&minorversion=65`
    );
    const pref = prefs?.QueryResponse?.Preferences?.[0];
    const groups = pref?.SalesFormsPrefs?.CustomField;
    if (!Array.isArray(groups)) return null;

    const entries: Array<{ Name?: string; StringValue?: string; BooleanValue?: boolean }> = [];
    for (const group of groups) {
      const inner = group?.CustomField;
      if (Array.isArray(inner)) entries.push(...inner);
    }

    const names = new Map<string, string>();
    const enabled = new Map<string, boolean>();
    for (const entry of entries) {
      const name = String(entry?.Name || '');
      const nameMatch = name.match(/SalesCustomName(\d)/i);
      if (nameMatch && entry?.StringValue) {
        names.set(nameMatch[1], String(entry.StringValue));
      }
      const useMatch = name.match(/UseSalesCustom(\d)/i);
      if (useMatch) {
        enabled.set(useMatch[1], entry?.BooleanValue === true || String(entry?.StringValue) === 'true');
      }
    }

    const looksLikePo = (label: string) => /\bp\.?\s*o\.?\b|purchase\s*order/i.test(label);
    for (const [slot, label] of names) {
      if (enabled.get(slot) !== false && looksLikePo(label)) {
        return { definitionId: slot, name: label };
      }
    }
    return null;
  } catch {
    return null;
  }
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

async function fetchCompanyCountry(tenantId: string): Promise<string> {
  try {
    const integration = await loadIntegration(tenantId);
    if (!integration?.realmId) return 'US';
    const info = await qboRequest<any>(
      tenantId,
      'GET',
      `/companyinfo/${integration.realmId}?minorversion=65`
    );
    return String(info?.CompanyInfo?.Country || 'US').toUpperCase();
  } catch {
    return 'US';
  }
}

function taxRateFromCode(taxCode: any, rateById: Map<string, number>): number {
  const details = taxCode?.SalesTaxRateList?.TaxRateDetail || [];
  let sum = 0;
  for (const detail of details) {
    const id = String(detail?.TaxRateRef?.value || '');
    if (!id) continue;
    const value = rateById.get(id);
    if (typeof value === 'number' && Number.isFinite(value)) sum += value;
  }
  return sum;
}

async function findMatchingSalesTax(
  tenantId: string,
  ratePercent: number
): Promise<{ taxCodeId: string; taxRateId: string | null; percent: number } | null> {
  try {
    const [codesRes, ratesRes] = await Promise.all([
      qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${encodeURIComponent(
          'SELECT * FROM TaxCode MAXRESULTS 100'
        )}&minorversion=65`
      ),
      qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${encodeURIComponent(
          'SELECT * FROM TaxRate MAXRESULTS 100'
        )}&minorversion=65`
      )
    ]);
    const codes = codesRes?.QueryResponse?.TaxCode || [];
    const rates = ratesRes?.QueryResponse?.TaxRate || [];
    const rateById = new Map<string, number>();
    for (const rate of rates) {
      if (!rate?.Id) continue;
      const value = Number(rate.RateValue);
      if (Number.isFinite(value)) rateById.set(String(rate.Id), value);
    }

    const candidates = codes.filter((code: any) => {
      if (!code?.Id) return false;
      if (code.Active === false) return false;
      const name = String(code.Name || '').toUpperCase();
      if (name === 'NON' || name === 'EXEMPT') return false;
      return Boolean(code.SalesTaxRateList?.TaxRateDetail?.length);
    });
    if (candidates.length === 0) return null;

    let best: { taxCode: any; percent: number; distance: number } | null = null;
    for (const code of candidates) {
      const percent = taxRateFromCode(code, rateById);
      const distance = Math.abs(percent - ratePercent);
      if (!best || distance < best.distance) {
        best = { taxCode: code, percent, distance };
      }
    }
    if (!best) return null;
    const taxRateId = String(
      best.taxCode?.SalesTaxRateList?.TaxRateDetail?.[0]?.TaxRateRef?.value || ''
    );
    return {
      taxCodeId: String(best.taxCode.Id),
      taxRateId: taxRateId || null,
      percent: best.percent || ratePercent
    };
  } catch (err) {
    console.warn('[quickbooks] tax code lookup failed', (err as any)?.message || err);
    return null;
  }
}

function applyLineTaxCodes(
  lines: any[],
  params: { isUs: boolean; taxable: boolean; taxCodeId?: string | null }
) {
  for (const line of lines) {
    if (line?.DetailType !== 'SalesItemLineDetail' || !line.SalesItemLineDetail) continue;
    const isShipping = String(line.SalesItemLineDetail.ItemRef?.value || '') === 'SHIPPING_ITEM_ID';
    if (params.isUs) {
      line.SalesItemLineDetail.TaxCodeRef = {
        value: params.taxable && !isShipping ? 'TAX' : 'NON'
      };
    } else if (params.taxCodeId) {
      line.SalesItemLineDetail.TaxCodeRef = {
        value: params.taxable && !isShipping ? params.taxCodeId : params.taxCodeId
      };
    }
  }
}

async function applySalesTaxToPayload(
  tenantId: string,
  doc: Record<string, any>,
  payload: Record<string, any>
): Promise<void> {
  const lines = Array.isArray(payload.Line) ? payload.Line : [];
  const rate = Number(doc.taxRate) || 0;
  const discount = Number(doc.discount) || 0;
  const subtotal = Number(doc.subtotal) || 0;
  const taxableAmount = Math.max(0, subtotal - Math.min(subtotal, discount));
  const storedTax = Number(doc.salesTax);
  const totalTax =
    Number.isFinite(storedTax) && storedTax >= 0
      ? Math.round(storedTax * 100) / 100
      : Math.round(((taxableAmount * rate) / 100) * 100) / 100;
  const country = await fetchCompanyCountry(tenantId);
  const isUs = country === 'US' || country === 'USA';
  const taxable = rate > 0 || totalTax > 0.009;
  const match = taxable ? await findMatchingSalesTax(tenantId, rate || 0) : null;

  applyLineTaxCodes(lines, {
    isUs,
    taxable,
    taxCodeId: match?.taxCodeId || null
  });

  if (!taxable) return;

  const txnTax: Record<string, any> = { TotalTax: totalTax };
  if (match?.taxCodeId) {
    txnTax.TxnTaxCodeRef = { value: match.taxCodeId };
  }
  if (match?.taxRateId) {
    txnTax.TaxLine = [
      {
        Amount: totalTax,
        DetailType: 'TaxLineDetail',
        TaxLineDetail: {
          TaxRateRef: { value: match.taxRateId },
          PercentBased: true,
          TaxPercent: match.percent || rate,
          NetAmountTaxable: Math.round(taxableAmount * 100) / 100
        }
      }
    ];
  }
  payload.TxnTaxDetail = txnTax;
}

async function getBankAccountId(tenantId: string): Promise<string | null> {
  const queries = [
    "SELECT * FROM Account WHERE AccountType = 'Bank' AND Active = true MAXRESULTS 20",
    "SELECT * FROM Account WHERE AccountSubType = 'Checking' AND Active = true MAXRESULTS 10"
  ];
  for (const q of queries) {
    try {
      const accounts = await qboRequest<any>(
        tenantId,
        'GET',
        `/query?query=${encodeURIComponent(q)}&minorversion=65`
      );
      const list = accounts?.QueryResponse?.Account || [];
      const preferred =
        list.find((a: any) => /check|operating|business|payroll/i.test(String(a.Name || ''))) ||
        list[0];
      if (preferred?.Id) return String(preferred.Id);
    } catch {
      // try next query
    }
  }
  return null;
}

async function getCreditCardAccountId(tenantId: string): Promise<string | null> {
  try {
    const accounts = await qboRequest<any>(
      tenantId,
      'GET',
      `/query?query=${encodeURIComponent(
        "SELECT * FROM Account WHERE AccountType = 'Credit Card' AND Active = true MAXRESULTS 10"
      )}&minorversion=65`
    );
    const list = accounts?.QueryResponse?.Account || [];
    return list[0]?.Id ? String(list[0].Id) : null;
  } catch {
    return null;
  }
}

/**
 * Create a QBO Payment (Receive Payment) for a NurseryOS invoice that is paid
 * and was previously pushed (`qboInvoiceId`). Safe to call multiple times.
 */
export async function syncPaidInvoicePaymentToQbo(
  tenantId: string,
  documentId: string,
  opts?: { uid?: string }
): Promise<{
  synced: boolean;
  skipped?: boolean;
  reason?: string;
  qboPaymentId?: string;
}> {
  if (!isFirebaseAdminConfigured()) {
    return { synced: false, skipped: true, reason: 'firebase_admin' };
  }

  let integration: QbIntegration | null = null;
  try {
    integration = await loadIntegration(tenantId);
  } catch {
    return { synced: false, skipped: true, reason: 'not_connected' };
  }
  if (!integration?.realmId) {
    return { synced: false, skipped: true, reason: 'not_connected' };
  }

  const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return { synced: false, skipped: true, reason: 'missing_document' };
  }
  const doc = snap.data() || {};
  if (doc.type !== 'invoice') {
    return { synced: false, skipped: true, reason: 'not_invoice' };
  }
  if (String(doc.paymentStatus || '') !== 'paid') {
    return { synced: false, skipped: true, reason: 'not_paid' };
  }
  if (doc.qboPaymentId) {
    return {
      synced: true,
      skipped: true,
      reason: 'already_synced',
      qboPaymentId: String(doc.qboPaymentId)
    };
  }

  const qboInvoiceId = String(doc.qboInvoiceId || '').trim();
  if (!qboInvoiceId) {
    return { synced: false, skipped: true, reason: 'invoice_not_pushed' };
  }

  const invRes = await qboRequest<any>(
    tenantId,
    'GET',
    `/invoice/${qboInvoiceId}?minorversion=65`
  );
  const invoice = invRes?.Invoice;
  if (!invoice?.Id) {
    throw Object.assign(new Error('QuickBooks invoice not found for payment sync.'), {
      status: 404
    });
  }
  const customerId = String(invoice.CustomerRef?.value || '').trim();
  if (!customerId) {
    throw Object.assign(new Error('QuickBooks invoice is missing a customer.'), { status: 400 });
  }

  let amount =
    typeof doc.stripePaidAmountCents === 'number' && Number.isFinite(doc.stripePaidAmountCents)
      ? Math.round(Number(doc.stripePaidAmountCents)) / 100
      : Number(doc.grandTotal) || 0;

  const balance = invoice.Balance != null ? Number(invoice.Balance) : null;
  if (balance != null && Number.isFinite(balance)) {
    if (balance <= 0.009) {
      const now = new Date().toISOString();
      await docRef.set(
        {
          qboPaymentSyncedAt: now,
          qboPaymentNote: 'Invoice already paid in QuickBooks',
          updatedAt: now
        },
        { merge: true }
      );
      return { synced: true, skipped: true, reason: 'already_paid_in_qbo' };
    }
    if (amount > balance + 0.01) {
      amount = balance;
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { synced: false, skipped: true, reason: 'invalid_amount' };
  }

  const rounded = Math.round(amount * 100) / 100;
  const txnDate = String(doc.paidAt || new Date().toISOString()).slice(0, 10);
  const method = String(doc.paymentMethod || 'payment');
  const refNum = String(
    doc.paymentReference || doc.stripePaymentIntentId || doc.documentNumber || ''
  )
    .trim()
    .slice(0, 21);
  const privateNote = `NurseryOS · ${method}${
    doc.stripePaymentIntentId ? ` · ${doc.stripePaymentIntentId}` : ''
  }`.slice(0, 4000);

  const created = await qboRequest<any>(tenantId, 'POST', '/payment?minorversion=65', {
    TotalAmt: rounded,
    CustomerRef: { value: customerId },
    TxnDate: txnDate,
    ...(refNum ? { PaymentRefNum: refNum } : {}),
    PrivateNote: privateNote,
    Line: [
      {
        Amount: rounded,
        LinkedTxn: [
          {
            TxnId: qboInvoiceId,
            TxnType: 'Invoice'
          }
        ]
      }
    ]
  });

  const paymentId = created?.Payment?.Id ? String(created.Payment.Id) : null;
  if (!paymentId) {
    throw new Error('QuickBooks did not return a payment id.');
  }

  const now = new Date().toISOString();
  await docRef.set(
    {
      qboPaymentId: paymentId,
      qboPaymentSyncedAt: now,
      qboPaymentSyncedByUserId: opts?.uid || 'system',
      qboPaymentNote: null,
      updatedAt: now
    },
    { merge: true }
  );

  return { synced: true, qboPaymentId: paymentId };
}

async function findOrCreateCustomer(
  tenantId: string,
  doc: Record<string, any>
): Promise<{ id: string; displayName: string }> {
  const displayName = sanitizeQbName(doc.billToName || doc.customerName || '', 100);
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

function isQboShippingLine(line: any): boolean {
  if (line?.DetailType !== 'SalesItemLineDetail') return false;
  const ref = String(line?.SalesItemLineDetail?.ItemRef?.value || '').trim();
  const name = String(line?.SalesItemLineDetail?.ItemRef?.name || '').trim();
  const desc = String(line?.Description || '').trim();
  return (
    ref === 'SHIPPING_ITEM_ID' ||
    /^shipping$/i.test(name) ||
    /^freight$/i.test(name) ||
    /^shipping$/i.test(desc) ||
    /^freight$/i.test(desc)
  );
}

/**
 * QBO sparse updates ignore a new SHIPPING_ITEM_ID line unless it keeps the
 * existing shipping line Id. Reuse Ids for matching plant/discount lines too.
 */
function mergeLinesForQboUpdate(existingLines: any[], mappedLines: any[]): any[] {
  const existing = Array.isArray(existingLines) ? existingLines : [];
  const existingShipping = existing.find(isQboShippingLine);
  const existingDiscount = existing.find((l) => l?.DetailType === 'DiscountLineDetail');
  const existingSales = existing.filter(
    (l) => l?.DetailType === 'SalesItemLineDetail' && !isQboShippingLine(l)
  );
  const used = new Set<string>();
  const out: any[] = [];
  const mappedHasShipping = mappedLines.some(isQboShippingLine);

  for (const line of mappedLines) {
    if (isQboShippingLine(line)) {
      if (existingShipping?.Id) {
        out.push({
          ...line,
          Id: String(existingShipping.Id),
          ...(existingShipping.LineNum != null ? { LineNum: existingShipping.LineNum } : {}),
          SalesItemLineDetail: {
            ...line.SalesItemLineDetail,
            ItemRef:
              existingShipping.SalesItemLineDetail?.ItemRef ||
              line.SalesItemLineDetail?.ItemRef
          }
        });
      } else {
        out.push(line);
      }
      continue;
    }
    if (line?.DetailType === 'DiscountLineDetail') {
      if (existingDiscount?.Id) {
        out.push({
          ...line,
          Id: String(existingDiscount.Id),
          ...(existingDiscount.LineNum != null ? { LineNum: existingDiscount.LineNum } : {})
        });
      } else {
        out.push(line);
      }
      continue;
    }
    if (line?.DetailType === 'SalesItemLineDetail') {
      const itemId = String(line.SalesItemLineDetail?.ItemRef?.value || '');
      const match = existingSales.find((ex) => {
        const id = String(ex.Id || '');
        if (!id || used.has(id)) return false;
        return String(ex.SalesItemLineDetail?.ItemRef?.value || '') === itemId;
      });
      if (match?.Id) {
        used.add(String(match.Id));
        out.push({
          ...line,
          Id: String(match.Id),
          ...(match.LineNum != null ? { LineNum: match.LineNum } : {})
        });
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  if (!mappedHasShipping && existingShipping?.Id) {
    out.push({
      Id: String(existingShipping.Id),
      ...(existingShipping.LineNum != null ? { LineNum: existingShipping.LineNum } : {}),
      DetailType: 'SalesItemLineDetail',
      Amount: 0,
      Description: existingShipping.Description || 'Shipping',
      SalesItemLineDetail: {
        ItemRef:
          existingShipping.SalesItemLineDetail?.ItemRef || { value: 'SHIPPING_ITEM_ID' },
        Qty: 1,
        UnitPrice: 0
      }
    });
  }

  return out;
}

async function mapDocToInvoice(
  tenantId: string,
  doc: Record<string, any>,
  customerRefId: string,
  incomeAccountId: string
) {
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  if (rawItems.length === 0) {
    throw Object.assign(
      new Error(
        'This document has no plant line items saved. Save it to the customer again, then push.'
      ),
      { status: 400 }
    );
  }

  const lines = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    if (item.unavailable) continue;
    const plantName = String(item.plantName || item.name || '').trim();
    const containerSize = String(item.containerSize || item.size || '').trim();
    const qty = Number(item.quantity ?? item.qty) || 0;
    const unitPrice = Number(item.unitPrice ?? item.price) || 0;
    if (!plantName && qty === 0 && unitPrice === 0) continue;

    const itemRefId = await findOrCreateItemForLine(
      tenantId,
      plantName || `Line ${index + 1}`,
      containerSize,
      incomeAccountId
    );
    const safeQty = qty > 0 ? qty : 1;
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number((safeQty * unitPrice).toFixed(2)),
      Description: item.notes ? sanitizeQbString(item.notes, 4000) || undefined : undefined,
      SalesItemLineDetail: {
        ItemRef: { value: itemRefId },
        Qty: safeQty,
        UnitPrice: unitPrice
      }
    });
  }

  const freight = Number(doc.freightCharge) || 0;
  if (freight > 0 && doc.type !== 'credit_memo') {
    // SHIPPING_ITEM_ID maps to QBO's built-in Shipping field (not a product line),
    // when Company Settings → Sales → Shipping is enabled.
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(freight.toFixed(2)),
      Description: 'Shipping',
      SalesItemLineDetail: {
        ItemRef: { value: 'SHIPPING_ITEM_ID' },
        Qty: 1,
        UnitPrice: freight
      }
    });
  }

  const discount = Number(doc.discount) || 0;
  if (discount > 0 && doc.type !== 'credit_memo') {
    lines.push({
      DetailType: 'DiscountLineDetail',
      Amount: Number(discount.toFixed(2)),
      DiscountLineDetail: {
        PercentBased: false
      }
    });
  }

  if (lines.length === 0) {
    throw Object.assign(
      new Error('No usable plant lines found on this document. Re-save it, then push again.'),
      { status: 400 }
    );
  }

  const poNumber = sanitizeQbString(doc.poNumber, 31);
  let customField: Array<Record<string, any>> | undefined;
  if (poNumber) {
    const poDef = await getPoCustomFieldDefinition(tenantId);
    if (poDef) {
      customField = [
        {
          DefinitionId: poDef.definitionId,
          Name: poDef.name,
          Type: 'StringType',
          StringValue: poNumber
        }
      ];
    }
  }

  const paymentTerms = sanitizeQbString(doc.paymentTerms, 100);
  const memo = [
    paymentTerms ? `Terms: ${paymentTerms}` : '',
    poNumber ? `P.O. #: ${poNumber}` : ''
  ]
    .filter(Boolean)
    .join(' | ');

  const referencedInvoice = sanitizeQbString(doc.referencedInvoiceNumber, 21);
  const privateNote = sanitizeQbString(
    [
      doc.notes ? String(doc.notes) : '',
      poNumber ? `Customer PO #: ${poNumber}` : '',
      referencedInvoice ? `Applies to invoice ${referencedInvoice}` : '',
      `NurseryOS ${doc.type || 'invoice'} ${doc.documentNumber || ''}`.trim()
    ]
      .filter(Boolean)
      .join('\n'),
    4000
  );

  const payload: Record<string, any> = {
    DocNumber: sanitizeQbString(doc.documentNumber, 21) || undefined,
    TxnDate: String(doc.documentDate || new Date().toISOString()).slice(0, 10),
    DueDate: doc.type === 'credit_memo' ? undefined : doc.dueDate ? String(doc.dueDate).slice(0, 10) : undefined,
    PrivateNote: privateNote || undefined,
    CustomerRef: { value: customerRefId },
    Line: lines,
    CustomField: customField,
    CustomerMemo: memo ? { value: memo } : undefined,
    // Hosted pay link (invoiceLink) needs BillEmail + online payment flags.
    ...(doc.type === 'invoice' && doc.customerEmail
      ? { BillEmail: { Address: String(doc.customerEmail).slice(0, 100) } }
      : {}),
    ...(doc.type === 'invoice'
      ? {
          AllowOnlineCreditCardPayment: true,
          AllowOnlineACHPayment: true,
          AllowOnlinePayment: true
        }
      : {})
  };

  await applySalesTaxToPayload(tenantId, doc, payload);
  return payload;
}

/** Fetch QBO hosted invoice pay URL when Payments is enabled for the company. */
async function fetchQboInvoiceLink(
  tenantId: string,
  qboInvoiceId: string
): Promise<string | null> {
  try {
    const check = await qboRequest<any>(
      tenantId,
      'GET',
      `/invoice/${encodeURIComponent(qboInvoiceId)}?minorversion=65&include=invoiceLink`
    );
    const link = check?.Invoice?.InvoiceLink || check?.Invoice?.invoiceLink;
    return sanitizeCustomerPayLink(link ? String(link).trim() : null);
  } catch (err: any) {
    console.warn('[quickbooks] invoiceLink fetch failed:', err?.message || err);
    return null;
  }
}

/**
 * Sandbox InvoiceLinks 404 / redirect to Intuit "comingSoon" pages.
 * Never put those in customer emails.
 */
function sanitizeCustomerPayLink(link: string | null | undefined): string | null {
  const url = String(link || '').trim();
  if (!url) return null;
  const lower = url.toLowerCase();
  if (
    lower.includes('developer.intuit.com') ||
    lower.includes('comingssoon') ||
    lower.includes('comingsoon') ||
    lower.includes('/comingSoon') ||
    qbEnv() === 'sandbox'
  ) {
    return null;
  }
  if (!/^https:\/\//i.test(url)) return null;
  return url;
}

function sandboxPayLinkError(): Error {
  return Object.assign(
    new Error(
      'QuickBooks pay links do not work in Sandbox (customers get a 404). In Railway set QUICKBOOKS_ENVIRONMENT=production, reconnect QuickBooks in Team to your live company, turn on Payments, then create a new pay link.'
    ),
    { status: 400 }
  );
}

/**
 * Push NurseryOS invoice/estimate/credit memo to QBO (create or update).
 */
async function pushDocumentToQboInternal(
  tenantId: string,
  documentId: string,
  uid: string
): Promise<{
  qboInvoiceId: string;
  qboDocType: string;
  qboDocNumber: string | null;
  qboInvoiceLink: string | null;
  qboOpenUrl: string | null;
  customerName: string | null;
  totalAmt: number | null;
  lineCount: number | null;
  linePreview: string[];
  environment: QbEnvironment;
  companyName: string | null;
  verified: boolean;
  reused: boolean;
  updated: boolean;
}> {
  const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw Object.assign(new Error('Document not found.'), { status: 404 });
  }
  const doc = snap.data() || {};
  const kind = salesDocKind(doc.type);
  if (!kind) {
    throw Object.assign(
      new Error('Only invoices, estimates, and credit memos can be synced.'),
      { status: 400 }
    );
  }
  const spec = qboTxnSpec(kind);

  const existingId = String(doc.qboInvoiceId || '').trim();
  let existing: any | null = null;
  if (existingId) {
    existing = await getQboSalesTxn(tenantId, kind, existingId);
    if (!existing) {
      console.warn(
        `[quickbooks] stored QBO ${kind} ${existingId} is gone; creating a new one`
      );
    }
  }

  const customer = await findOrCreateCustomer(tenantId, doc);
  const incomeAccountId = await getIncomeAccountId(tenantId);
  const payload = await mapDocToInvoice(tenantId, doc, customer.id, incomeAccountId);
  if (existing && Array.isArray(payload.Line)) {
    payload.Line = mergeLinesForQboUpdate(existing.Line, payload.Line);
  }
  const writeBody = existing
    ? {
        ...payload,
        Id: String(existing.Id),
        SyncToken: String(existing.SyncToken ?? '0'),
        sparse: true
      }
    : payload;
  const attemptWrite = (body: any) =>
    qboRequest<any>(tenantId, 'POST', `/${spec.path}?minorversion=65`, body);

  let written: any;
  try {
    written = await attemptWrite(writeBody);
  } catch (err) {
    if (writeBody && writeBody.CustomField) {
      const withoutCustomField = { ...writeBody };
      delete withoutCustomField.CustomField;
      console.warn(
        '[quickbooks] push with CustomField failed, retrying without it',
        (err as any)?.message
      );
      written = await attemptWrite(withoutCustomField);
    } else {
      throw err;
    }
  }
  const entity = written?.[spec.entity];
  const qboId = entity?.Id ? String(entity.Id) : existing ? String(existing.Id) : null;
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
  let qboInvoiceLink: string | null = null;
  try {
    const checked = await getQboSalesTxn(tenantId, kind, qboId);
    verified = Boolean(checked?.Id);
    if (checked?.CustomerRef?.name) verifiedCustomer = String(checked.CustomerRef.name);
    if (checked?.TotalAmt != null) totalAmt = Number(checked.TotalAmt);
    const checkedLines = Array.isArray(checked?.Line) ? checked.Line : [];
    lineCount = checkedLines.filter((l: any) => l?.DetailType === 'SalesItemLineDetail').length;
    linePreview = checkedLines
      .filter((l: any) => l?.DetailType === 'SalesItemLineDetail')
      .slice(0, 5)
      .map((l: any) => String(l.SalesItemLineDetail?.ItemRef?.name || l.Description || 'Line'));
    if (kind === 'invoice') {
      const link = checked?.InvoiceLink || checked?.invoiceLink;
      if (link) qboInvoiceLink = sanitizeCustomerPayLink(String(link).trim());
    }
  } catch {
    verified = false;
  }

  if (!qboInvoiceLink && kind === 'invoice') {
    qboInvoiceLink = await fetchQboInvoiceLink(tenantId, qboId);
  }

  if (verified && lineCount === 0) {
    throw new Error(
      'QuickBooks saved this document with no plant lines. Re-save it in NurseryOS (with prices), then push again.'
    );
  }

  const openUrl = qbTxnOpenUrl(env, kind, qboId, integration?.realmId);
  const now = new Date().toISOString();
  const updated = Boolean(existing);

  await docRef.set(
    {
      qboInvoiceId: qboId,
      qboDocType: kind,
      qboDocNumber: entity?.DocNumber
        ? String(entity.DocNumber)
        : existing?.DocNumber
          ? String(existing.DocNumber)
          : null,
      qboOpenUrl: openUrl,
      qboInvoiceLink: qboInvoiceLink || null,
      qboSyncedAt: now,
      qboSyncedByUserId: uid,
      ...(existingId && existingId !== qboId
        ? { qboPaymentId: null, qboPaymentSyncedAt: null, qboPaymentNote: null }
        : {}),
      updatedAt: now
    },
    { merge: true }
  );

  return {
    qboInvoiceId: qboId,
    qboDocType: kind,
    qboDocNumber: entity?.DocNumber
      ? String(entity.DocNumber)
      : existing?.DocNumber
        ? String(existing.DocNumber)
        : null,
    qboInvoiceLink,
    qboOpenUrl: openUrl,
    customerName: verifiedCustomer,
    totalAmt,
    lineCount,
    linePreview,
    environment: env,
    companyName,
    verified,
    reused: false,
    updated
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

async function pushVendorBillToQboInternal(
  tenantId: string,
  billId: string,
  uid: string
): Promise<{
  qboBillId: string;
  qboDocNumber: string | null;
  vendorName: string | null;
  totalAmt: number | null;
  environment: QbEnvironment;
  companyName: string | null;
  openUrl: string | null;
  alreadySynced: boolean;
  updated: boolean;
}> {
  const billRef = getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`);
  const billSnap = await billRef.get();
  if (!billSnap.exists) {
    throw Object.assign(new Error('Vendor bill not found.'), { status: 404 });
  }
  const bill = billSnap.data() || {};
  const existingId = String(bill.qboBillId || '').trim();
  let existing: any | null = null;
  if (existingId) {
    existing = await getQboTxn(tenantId, 'bill', existingId);
    if (!existing) {
      console.warn(`[quickbooks] stored QBO bill ${existingId} is gone; creating a new one`);
    }
  }

  const vendorId = String(bill.vendorId || '').trim();
  let vendorData: Record<string, any> = {
    name: bill.vendorName,
    qboVendorId: null
  };
  if (vendorId) {
    const vendorSnap = await getAdminDb().doc(`tenants/${tenantId}/vendors/${vendorId}`).get();
    if (vendorSnap.exists) {
      vendorData = { id: vendorId, ...(vendorSnap.data() || {}) };
    }
  }

  const qbVendor = await findOrCreateVendor(tenantId, vendorData);
  if (vendorId && String(vendorData.qboVendorId || '') !== qbVendor.id) {
    await getAdminDb()
      .doc(`tenants/${tenantId}/vendors/${vendorId}`)
      .set(
        {
          qboVendorId: qbVendor.id,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );
  }

  const expenseAccountId = await getExpenseAccountId(tenantId);
  const payload = mapVendorBillToQboBill({
    bill,
    vendorRefId: qbVendor.id,
    expenseAccountId
  });
  const writeBody = existing
    ? {
        ...payload,
        Id: String(existing.Id),
        SyncToken: String(existing.SyncToken ?? '0'),
        sparse: true
      }
    : payload;

  const written = await qboRequest<any>(tenantId, 'POST', '/bill?minorversion=65', writeBody);
  const entity = written?.Bill;
  const qboId = entity?.Id ? String(entity.Id) : existing ? String(existing.Id) : null;
  if (!qboId) {
    throw new Error('QuickBooks did not return a bill id.');
  }

  const integration = await loadIntegration(tenantId);
  const env = integration?.environment || qbEnv();
  const companyName = integration?.realmId
    ? await fetchCompanyName(tenantId, integration.realmId)
    : null;
  const openUrl = qbTxnOpenUrl(env, 'bill', qboId, integration?.realmId);
  const now = new Date().toISOString();
  const updated = Boolean(existing);

  await billRef.set(
    {
      qboBillId: qboId,
      qboDocNumber: entity?.DocNumber
        ? String(entity.DocNumber)
        : existing?.DocNumber
          ? String(existing.DocNumber)
          : null,
      qboVendorId: qbVendor.id,
      qboOpenUrl: openUrl,
      qboSyncedAt: now,
      qboSyncedByUserId: uid,
      ...(existingId && existingId !== qboId
        ? { qboBillPaymentId: null, qboBillPaymentSyncedAt: null, qboBillPaymentNote: null }
        : {}),
      updatedAt: now
    },
    { merge: true }
  );

  return {
    qboBillId: qboId,
    qboDocNumber: entity?.DocNumber
      ? String(entity.DocNumber)
      : existing?.DocNumber
        ? String(existing.DocNumber)
        : null,
    vendorName: qbVendor.displayName,
    totalAmt: entity?.TotalAmt != null ? Number(entity.TotalAmt) : null,
    environment: env,
    companyName,
    openUrl,
    alreadySynced: false,
    updated
  };
}

/**
 * Create a QBO BillPayment for a NurseryOS vendor bill that is paid.
 */
export async function syncPaidVendorBillPaymentToQbo(
  tenantId: string,
  billId: string,
  opts?: { uid?: string }
): Promise<{
  synced: boolean;
  skipped?: boolean;
  reason?: string;
  qboBillPaymentId?: string;
}> {
  if (!isFirebaseAdminConfigured()) {
    return { synced: false, skipped: true, reason: 'firebase_admin' };
  }

  let integration: QbIntegration | null = null;
  try {
    integration = await loadIntegration(tenantId);
  } catch {
    return { synced: false, skipped: true, reason: 'not_connected' };
  }
  if (!integration?.realmId) {
    return { synced: false, skipped: true, reason: 'not_connected' };
  }

  const billRef = getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`);
  const snap = await billRef.get();
  if (!snap.exists) {
    return { synced: false, skipped: true, reason: 'missing_bill' };
  }
  let bill = snap.data() || {};
  if (String(bill.status || '') !== 'paid') {
    return { synced: false, skipped: true, reason: 'not_paid' };
  }
  if (bill.qboBillPaymentId) {
    return {
      synced: true,
      skipped: true,
      reason: 'already_synced',
      qboBillPaymentId: String(bill.qboBillPaymentId)
    };
  }

  let qboBillId = String(bill.qboBillId || '').trim();
  if (qboBillId) {
    const stillThere = await getQboTxn(tenantId, 'bill', qboBillId);
    if (!stillThere) qboBillId = '';
  }
  if (!qboBillId) {
    try {
      const pushed = await pushVendorBillToQboInternal(
        tenantId,
        billId,
        opts?.uid || 'system'
      );
      qboBillId = pushed.qboBillId;
      const refreshed = await billRef.get();
      bill = refreshed.data() || bill;
    } catch (err) {
      console.warn('[quickbooks] bill recreate before payment failed', (err as any)?.message || err);
      return { synced: false, skipped: true, reason: 'bill_not_pushed' };
    }
  }

  const qboBill = await getQboTxn(tenantId, 'bill', qboBillId);
  if (!qboBill?.Id) {
    return { synced: false, skipped: true, reason: 'bill_not_pushed' };
  }
  const vendorId = String(qboBill.VendorRef?.value || '').trim();
  if (!vendorId) {
    throw Object.assign(new Error('QuickBooks bill is missing a vendor.'), { status: 400 });
  }

  let amount = Number(bill.grandTotal) || Number(qboBill.TotalAmt) || 0;
  const balance = qboBill.Balance != null ? Number(qboBill.Balance) : null;
  if (balance != null && Number.isFinite(balance)) {
    if (balance <= 0.009) {
      const now = new Date().toISOString();
      await billRef.set(
        {
          qboBillPaymentSyncedAt: now,
          qboBillPaymentNote: 'Bill already paid in QuickBooks',
          updatedAt: now
        },
        { merge: true }
      );
      return { synced: true, skipped: true, reason: 'already_paid_in_qbo' };
    }
    if (amount > balance + 0.01) amount = balance;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { synced: false, skipped: true, reason: 'invalid_amount' };
  }

  const method = String(bill.paymentMethod || 'payment').toLowerCase();
  const useCard = method === 'cc' || method === 'card' || method === 'credit_card';
  const cardAccountId = useCard ? await getCreditCardAccountId(tenantId) : null;
  const bankAccountId = cardAccountId ? null : await getBankAccountId(tenantId);
  if (!cardAccountId && !bankAccountId) {
    throw Object.assign(
      new Error(
        'QuickBooks needs a Bank (or Credit Card) account to record a bill payment. Add one in the QuickBooks chart of accounts, then mark paid again.'
      ),
      { status: 400 }
    );
  }

  const rounded = Math.round(amount * 100) / 100;
  const txnDate = String(bill.paidAt || new Date().toISOString()).slice(0, 10);
  const refNum = String(bill.paymentReference || bill.billNumber || '')
    .trim()
    .slice(0, 21);
  const privateNote = `NurseryOS · ${method}${
    bill.stripeOutboundPaymentId ? ` · ${bill.stripeOutboundPaymentId}` : ''
  }`.slice(0, 4000);

  const paymentBody: Record<string, any> = {
    TotalAmt: rounded,
    VendorRef: { value: vendorId },
    TxnDate: txnDate,
    PrivateNote: privateNote,
    Line: [
      {
        Amount: rounded,
        LinkedTxn: [
          {
            TxnId: qboBillId,
            TxnType: 'Bill'
          }
        ]
      }
    ]
  };
  if (cardAccountId) {
    paymentBody.PayType = 'CreditCard';
    paymentBody.CreditCardPayment = {
      CCAccountRef: { value: cardAccountId }
    };
  } else {
    paymentBody.PayType = 'Check';
    paymentBody.CheckPayment = {
      BankAccountRef: { value: bankAccountId },
      PrintStatus: 'NotSet'
    };
    if (refNum) paymentBody.DocNumber = refNum;
  }

  const created = await qboRequest<any>(
    tenantId,
    'POST',
    '/billpayment?minorversion=65',
    paymentBody
  );
  const paymentId = created?.BillPayment?.Id ? String(created.BillPayment.Id) : null;
  if (!paymentId) {
    throw new Error('QuickBooks did not return a bill payment id.');
  }

  const now = new Date().toISOString();
  await billRef.set(
    {
      qboBillPaymentId: paymentId,
      qboBillPaymentSyncedAt: now,
      qboBillPaymentSyncedByUserId: opts?.uid || 'system',
      qboBillPaymentNote: null,
      updatedAt: now
    },
    { merge: true }
  );

  return { synced: true, qboBillPaymentId: paymentId };
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

      const result = await pushDocumentToQboInternal(tenantId, documentId, uid);

      res.json({
        success: true,
        qboInvoiceId: result.qboInvoiceId,
        qboDocType: result.qboDocType,
        qboDocNumber: result.qboDocNumber,
        qboInvoiceLink: result.qboInvoiceLink,
        customerName: result.customerName,
        totalAmt: result.totalAmt,
        lineCount: result.lineCount,
        linePreview: result.linePreview,
        environment: result.environment,
        companyName: result.companyName,
        verified: result.verified,
        reused: result.reused,
        updated: result.updated,
        openUrl: result.qboOpenUrl,
        sandboxUrl:
          result.environment === 'sandbox' ? `${qbAppBase('sandbox')}/app/invoices` : null
      });
    })
  );

  /**
   * Ensure invoice is in QBO and return the hosted pay link (Intuit invoiceLink).
   * Creates/pushes the invoice when needed. Stays in NurseryOS except the customer pay tab.
   */
  app.post('/api/quickbooks/ensure-pay-link', (req, res) =>
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
        res.status(404).json({ error: 'Invoice document not found.' });
        return;
      }
      const doc = snap.data() || {};
      if (doc.type !== 'invoice') {
        res.status(400).json({ error: 'Pay links are only available for invoices.' });
        return;
      }

      let qboInvoiceId = String(doc.qboInvoiceId || '').trim();
      let qboInvoiceLink = sanitizeCustomerPayLink(
        doc.qboInvoiceLink ? String(doc.qboInvoiceLink).trim() : ''
      );

      if (qbEnv() === 'sandbox') {
        throw sandboxPayLinkError();
      }

      if (qboInvoiceId) {
        const stillThere = await getQboSalesTxn(tenantId, 'invoice', qboInvoiceId);
        if (!stillThere) {
          qboInvoiceId = '';
          qboInvoiceLink = null;
        }
      }

      if (!qboInvoiceId) {
        const pushed = await pushDocumentToQboInternal(tenantId, documentId, uid);
        qboInvoiceId = pushed.qboInvoiceId;
        qboInvoiceLink = pushed.qboInvoiceLink || null;
      } else if (!qboInvoiceLink) {
        qboInvoiceLink = await fetchQboInvoiceLink(tenantId, qboInvoiceId);
        if (qboInvoiceLink) {
          await docRef.set(
            { qboInvoiceLink, updatedAt: new Date().toISOString() },
            { merge: true }
          );
        }
      }

      if (!qboInvoiceLink) {
        res.status(400).json({
          error:
            'QuickBooks did not return a working pay link. In your live QuickBooks company: turn on Payments (card/ACH), make sure the customer email is on the invoice, push again, then copy the pay link.'
        });
        return;
      }

      res.json({
        success: true,
        url: qboInvoiceLink,
        qboInvoiceId,
        qboInvoiceLink
      });
    })
  );

  /**
   * Pull payment status from QBO into NurseryOS (Balance === 0 → mark paid).
   */
  app.post('/api/quickbooks/refresh-payment-status', (req, res) =>
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
        res.status(404).json({ error: 'Invoice document not found.' });
        return;
      }
      const doc = snap.data() || {};
      if (doc.type !== 'invoice') {
        res.status(400).json({ error: 'Only invoices have payment status.' });
        return;
      }

      let qboInvoiceId = String(doc.qboInvoiceId || '').trim();
      if (!qboInvoiceId) {
        res.status(400).json({
          error: 'Push this invoice to QuickBooks first (or create a QBO pay link).',
          paid: false
        });
        return;
      }

      const invRes = await qboRequest<any>(
        tenantId,
        'GET',
        `/invoice/${encodeURIComponent(qboInvoiceId)}?minorversion=65&include=invoiceLink`
      );
      const invoice = invRes?.Invoice;
      if (!invoice?.Id) {
        res.status(404).json({ error: 'QuickBooks invoice not found.', paid: false });
        return;
      }

      const balance = Number(invoice.Balance);
      const totalAmt = Number(invoice.TotalAmt);
      const paidInQbo =
        (Number.isFinite(balance) && balance <= 0.009) ||
        (Number.isFinite(totalAmt) && totalAmt > 0 && Number.isFinite(balance) && balance <= 0.009);

      const link = invoice.InvoiceLink || invoice.invoiceLink;
      const qboInvoiceLink = link ? String(link).trim() : doc.qboInvoiceLink || null;
      const now = new Date().toISOString();

      if (paidInQbo && String(doc.paymentStatus || '') !== 'paid') {
        await docRef.set(
          {
            paymentStatus: 'paid',
            paidAt: now,
            paymentMethod: 'quickbooks',
            qboInvoiceLink: qboInvoiceLink || null,
            updatedAt: now
          },
          { merge: true }
        );
      } else if (qboInvoiceLink && qboInvoiceLink !== doc.qboInvoiceLink) {
        await docRef.set(
          { qboInvoiceLink, updatedAt: now },
          { merge: true }
        );
      }

      res.json({
        paid: paidInQbo || String(doc.paymentStatus || '') === 'paid',
        balance: Number.isFinite(balance) ? balance : null,
        totalAmt: Number.isFinite(totalAmt) ? totalAmt : null,
        qboInvoiceLink: qboInvoiceLink || null,
        paymentStatus: paidInQbo ? 'paid' : String(doc.paymentStatus || 'unpaid')
      });
    })
  );

  /**
   * Create a QuickBooks Receive Payment against a previously pushed invoice.
   * Used after Mark paid in NurseryOS (or legacy Stripe collect).
   */
  app.post('/api/quickbooks/push-payment', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const documentId = String(req.body?.documentId || '');
      if (!tenantId || !documentId) {
        res.status(400).json({ error: 'tenantId and documentId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const result = await syncPaidInvoicePaymentToQbo(tenantId, documentId, { uid });
      if (!result.synced && result.reason === 'invoice_not_pushed') {
        res.status(400).json({
          error:
            'Push this invoice to QuickBooks first, then sync the payment (or collect via QBO pay link).',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && result.reason === 'not_paid') {
        res.status(400).json({
          error: 'Mark the invoice paid (or wait for QBO payment) before syncing payment to QuickBooks.',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && result.reason === 'not_connected') {
        res.status(400).json({
          error: 'Connect QuickBooks in Team settings first.',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && !result.skipped) {
        res.status(400).json({
          error: 'Could not sync payment to QuickBooks.',
          reason: result.reason || null
        });
        return;
      }

      res.json({
        success: true,
        ...result
      });
    })
  );

  /**
   * Push a NurseryOS vendor bill to QuickBooks as an AP Bill (same connected company).
   */
  app.post('/api/quickbooks/push-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const billId = String(req.body?.billId || '');
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const result = await pushVendorBillToQboInternal(tenantId, billId, uid);
      res.json({
        success: true,
        alreadySynced: result.alreadySynced,
        updated: result.updated,
        qboBillId: result.qboBillId,
        qboDocNumber: result.qboDocNumber,
        vendorName: result.vendorName,
        totalAmt: result.totalAmt,
        environment: result.environment,
        companyName: result.companyName,
        openUrl: result.openUrl
      });
    })
  );

  /**
   * Create a QuickBooks Bill Payment against a previously pushed vendor bill.
   */
  app.post('/api/quickbooks/push-bill-payment', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const billId = String(req.body?.billId || '');
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const result = await syncPaidVendorBillPaymentToQbo(tenantId, billId, { uid });
      if (!result.synced && result.reason === 'bill_not_pushed') {
        res.status(400).json({
          error:
            'Push this vendor bill to QuickBooks first, then mark it paid again to record the Bill Payment.',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && result.reason === 'not_paid') {
        res.status(400).json({
          error: 'Mark the vendor bill paid before syncing the payment to QuickBooks.',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && result.reason === 'not_connected') {
        res.status(400).json({
          error: 'Connect QuickBooks in Team settings first.',
          reason: result.reason
        });
        return;
      }
      if (!result.synced && !result.skipped) {
        res.status(400).json({
          error: 'Could not sync bill payment to QuickBooks.',
          reason: result.reason || null
        });
        return;
      }

      res.json({
        success: true,
        ...result
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

  app.post('/api/quickbooks/delete-document', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const documentId = String(req.body?.documentId || '');
      if (!tenantId || !documentId) {
        res.status(400).json({ error: 'tenantId and documentId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.realmId) {
        res.json({ skipped: true, reason: 'not_connected' });
        return;
      }

      const snap = await getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`).get();
      if (!snap.exists) {
        res.json({ skipped: true, reason: 'not_found' });
        return;
      }
      const doc = snap.data() || {};
      const qboId = String(doc.qboInvoiceId || '').trim();
      if (!qboId) {
        res.json({ skipped: true, reason: 'not_synced' });
        return;
      }
      const docType = salesDocKind(doc.type) || 'invoice';
      const result = await deleteQboTxn(tenantId, docType, qboId);
      res.json({ success: true, ...result });
    })
  );

  app.post('/api/quickbooks/delete-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const billId = String(req.body?.billId || '');
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }
      await assertCanPushInvoice(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.realmId) {
        res.json({ skipped: true, reason: 'not_connected' });
        return;
      }

      const snap = await getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`).get();
      if (!snap.exists) {
        res.json({ skipped: true, reason: 'not_found' });
        return;
      }
      const bill = snap.data() || {};
      const qboId = String(bill.qboBillId || '').trim();
      if (!qboId) {
        res.json({ skipped: true, reason: 'not_synced' });
        return;
      }
      const result = await deleteQboTxn(tenantId, 'bill', qboId);
      res.json({ success: true, ...result });
    })
  );
}
