import type { Express, Request, Response } from 'express';
import express from 'express';
import Stripe from 'stripe';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

interface StripeIntegration {
  provider: 'stripe';
  accountId: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  /** Stripe account type / controller dashboard — Express cannot use Treasury. */
  accountKind?: 'express' | 'custom' | 'controller';
  /** treasury capability: active | inactive | pending | unrequested */
  treasuryCapability?: string;
  financialAccountId?: string | null;
  financialAccountStatus?: string | null;
  connectedAt: string;
  connectedByUserId: string;
  updatedAt: string;
}

const BASE_CONNECT_CAPABILITIES = {
  card_payments: { requested: true },
  transfers: { requested: true },
  us_bank_account_ach_payments: { requested: true }
} as const;

const CONNECT_CAPABILITIES = {
  ...BASE_CONNECT_CAPABILITIES,
  treasury: { requested: true }
} as const;

const TREASURY_ACTIVATE_URL = 'https://dashboard.stripe.com/setup/treasury/activate';
const TREASURY_DASHBOARD_URL = 'https://dashboard.stripe.com/test/connect/financial-accounts';

function isUnknownTreasuryCapabilityError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /unknown capability:\s*treasury/i.test(msg);
}

async function retrievePlatformAccount(stripe: Stripe): Promise<{
  id: string;
  name: string;
  livemode: boolean;
  country: string | null;
}> {
  const account = await stripe.accounts.retrieve();
  const name =
    String(account.settings?.dashboard?.display_name || '').trim() ||
    String(account.business_profile?.name || '').trim() ||
    String(account.email || '').trim() ||
    account.id;
  return {
    id: account.id,
    name,
    livemode: Boolean(account.livemode),
    country: account.country || null
  };
}

function keyHint(): string {
  const key = requireStripeSecret();
  if (key.length < 12) return 'sk_…';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function treasuryNotActivatedError(platform?: {
  id: string;
  name: string;
  livemode: boolean;
}): Error {
  const where = platform
    ? ` NurseryOS is using Stripe account ${platform.id} (${platform.name}, ${
        platform.livemode ? 'LIVE' : 'TEST'
      }, key ${keyHint()}).`
    : ` NurseryOS key: ${keyHint()}.`;
  return Object.assign(
    new Error(
      `Stripe Treasury is not activated for the API key NurseryOS is using (Unknown capability: treasury).${where} ` +
        `In Dashboard, switch into THAT same account/sandbox (Account ID must match), open ${TREASURY_ACTIVATE_URL}, ` +
        `activate Issuing & Treasury, confirm Connect → Stripe Treasury loads, then copy that sandbox’s Secret key into Railway STRIPE_SECRET_KEY and redeploy. ` +
        `Activating Treasury on a different sandbox/account will not work.`
    ),
    { status: 400, code: 'treasury_not_activated' }
  );
}

/** Cached probe — whether this secret key can request `treasury` on connected accounts. */
let treasuryAccessCache: { fingerprint: string; ok: boolean; at: number } | null = null;

async function platformHasTreasuryAccess(stripe: Stripe): Promise<boolean> {
  const fingerprint = requireStripeSecret().slice(0, 14);
  if (
    treasuryAccessCache &&
    treasuryAccessCache.fingerprint === fingerprint &&
    Date.now() - treasuryAccessCache.at < 60 * 1000
  ) {
    return treasuryAccessCache.ok;
  }

  let accountId: string | null = null;
  try {
    const account = await stripe.accounts.create({
      type: 'custom',
      country: 'US',
      capabilities: {
        transfers: { requested: true },
        treasury: { requested: true }
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: '127.0.0.1'
      },
      metadata: { nurseryos_probe: 'treasury' }
    });
    accountId = account.id;
    const treasuryState = String(
      (account.capabilities as Record<string, string | null> | undefined)?.treasury || ''
    );
    const ok = treasuryState === 'active' || treasuryState === 'pending' || treasuryState === 'inactive';
    treasuryAccessCache = { fingerprint, ok, at: Date.now() };
    return ok;
  } catch (err) {
    if (isUnknownTreasuryCapabilityError(err)) {
      treasuryAccessCache = { fingerprint, ok: false, at: Date.now() };
      return false;
    }
    // Don't treat unrelated errors as "treasury available" — probe again next time.
    console.warn('[stripe] treasury access probe inconclusive', err);
    treasuryAccessCache = { fingerprint, ok: false, at: Date.now() };
    return false;
  } finally {
    if (accountId) {
      try {
        await stripe.accounts.del(accountId);
      } catch {
        // ignore probe cleanup failures
      }
    }
  }
}

function appOrigin(): string {
  return (process.env.APP_URL || 'https://nurseryos.app').replace(/\/$/, '');
}

function requireStripeSecret(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw Object.assign(
      new Error(
        'Stripe is not configured. Set STRIPE_SECRET_KEY (and STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET) on the server.'
      ),
      { status: 503 }
    );
  }
  return key;
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(requireStripeSecret(), {
      apiVersion: '2025-02-24.acacia'
    });
  }
  return stripeClient;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

function integrationRef(tenantId: string) {
  return getAdminDb().doc(`tenants/${tenantId}/integrations/stripe`);
}

async function loadIntegration(tenantId: string): Promise<StripeIntegration | null> {
  const snap = await integrationRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() as StripeIntegration;
}

/**
 * Sandbox-only: Express hosted onboarding forces SSN entry and rejects Stripe’s
 * own test IDs after auto-hyphenating. Create a Custom account fully verified
 * via API so Connect works without the hosted KYC form.
 */
async function createSandboxReadyAccount(
  stripe: Stripe,
  opts: {
    tenantId: string;
    tenantName: string;
    email?: string;
    ip: string;
    withTreasury: boolean;
  }
): Promise<Stripe.Account> {
  const { tenantId, tenantName, email, ip, withTreasury } = opts;
  const tosDate = Math.floor(Date.now() / 1000);
  const tosIp = ip || '127.0.0.1';
  const params: Stripe.AccountCreateParams = {
    type: 'custom',
    country: 'US',
    email: email || undefined,
    business_type: 'individual',
    capabilities: withTreasury
      ? { ...CONNECT_CAPABILITIES }
      : { ...BASE_CONNECT_CAPABILITIES },
    business_profile: {
      name: tenantName,
      mcc: '5261',
      url: 'https://accessible.stripe.com',
      product_description: `${tenantName} nursery wholesale and plant orders`
    },
    individual: {
      first_name: 'Jenny',
      last_name: 'Rosen',
      email: email || undefined,
      phone: '0000000000',
      id_number: '222222222',
      dob: { day: 1, month: 1, year: 1901 },
      address: {
        line1: 'address_full_match',
        city: 'South San Francisco',
        state: 'CA',
        postal_code: '94080',
        country: 'US'
      }
    },
    external_account: {
      object: 'bank_account',
      country: 'US',
      currency: 'usd',
      routing_number: '110000000',
      account_number: '000123456789',
      account_holder_name: 'Jenny Rosen',
      account_holder_type: 'individual'
    },
    tos_acceptance: {
      date: tosDate,
      ip: tosIp
    },
    metadata: {
      tenantId,
      nurseryos: '1',
      sandbox: '1',
      ...(withTreasury ? { treasury: '1' } : {})
    }
  };

  if (withTreasury) {
    params.settings = {
      treasury: {
        tos_acceptance: {
          date: tosDate,
          ip: tosIp
        }
      }
    };
  }

  return stripe.accounts.create(params);
}

async function fundSandboxFinancialAccount(
  stripe: Stripe,
  accountId: string,
  financialAccountId: string,
  amountCents = 100_000
): Promise<number | null> {
  try {
    const credit = await stripe.testHelpers.treasury.receivedCredits.create(
      {
        amount: amountCents,
        currency: 'usd',
        financial_account: financialAccountId,
        network: 'ach'
      },
      { stripeAccount: accountId }
    );
    return typeof credit.amount === 'number' ? credit.amount : amountCents;
  } catch (err) {
    console.warn('[stripe] sandbox FA fund failed', err);
    return null;
  }
}

function accountKindFromStripe(account: Stripe.Account): StripeIntegration['accountKind'] {
  if (account.type === 'express') return 'express';
  if (account.type === 'custom') return 'custom';
  const controller = account.controller as
    | { dashboard?: { type?: string }; type?: string }
    | undefined;
  if (controller?.dashboard?.type === 'express') return 'express';
  if (controller?.dashboard?.type === 'none') return 'controller';
  return 'custom';
}

async function ensureFinancialAccount(
  stripe: Stripe,
  accountId: string,
  existingId?: string | null
): Promise<{ id: string; status: string } | null> {
  if (existingId) {
    try {
      const fa = await stripe.treasury.financialAccounts.retrieve(existingId, {
        stripeAccount: accountId
      });
      return { id: fa.id, status: String(fa.status || 'open') };
    } catch (err) {
      console.warn('[stripe] financial account retrieve failed', err);
    }
  }

  const listed = await stripe.treasury.financialAccounts.list(
    { limit: 1 },
    { stripeAccount: accountId }
  );
  if (listed.data[0]) {
    return { id: listed.data[0].id, status: String(listed.data[0].status || 'open') };
  }

  const created = await stripe.treasury.financialAccounts.create(
    {
      supported_currencies: ['usd'],
      features: {
        financial_addresses: { aba: { requested: true } },
        inbound_transfers: { ach: { requested: true } },
        outbound_payments: { ach: { requested: true } },
        intra_stripe_flows: { requested: true }
      }
    },
    { stripeAccount: accountId }
  );
  return { id: created.id, status: String(created.status || 'open') };
}

function clientIp(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const first = forwarded.split(',')[0]?.trim();
  if (first) return first;
  return String(req.socket.remoteAddress || '127.0.0.1');
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
    throw Object.assign(new Error('Only owners and admins can manage Stripe Connect.'), {
      status: 403
    });
  }
}

async function assertCanCreatePayLink(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office', 'sales'])) {
    throw Object.assign(new Error('You do not have permission to create payment links.'), {
      status: 403
    });
  }
}

async function assertCanPayVendorBills(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office'])) {
    throw Object.assign(new Error('You do not have permission to pay vendor bills.'), {
      status: 403
    });
  }
}

function httpError(res: Response, err: any) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[stripe]', err);
  res.status(status).json({
    error: err?.message || 'Stripe request failed.'
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

async function refreshAccountStatus(tenantId: string, accountId: string, uid?: string) {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(accountId);
  const existing = await loadIntegration(tenantId);
  const now = new Date().toISOString();
  const treasuryCapability = String(
    (account.capabilities as Record<string, string | null> | undefined)?.treasury || 'unrequested'
  );
  const kind = accountKindFromStripe(account);

  let financialAccountId = existing?.financialAccountId || null;
  let financialAccountStatus = existing?.financialAccountStatus || null;

  if (treasuryCapability === 'active') {
    try {
      const fa = await ensureFinancialAccount(stripe, accountId, financialAccountId);
      if (fa) {
        financialAccountId = fa.id;
        financialAccountStatus = fa.status;
      }
    } catch (err) {
      console.warn('[stripe] ensure financial account failed', err);
    }
  }

  const doc: StripeIntegration = {
    provider: 'stripe',
    accountId,
    chargesEnabled: Boolean(account.charges_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    payoutsEnabled: Boolean(account.payouts_enabled),
    accountKind: kind,
    treasuryCapability,
    financialAccountId,
    financialAccountStatus,
    connectedAt: existing?.connectedAt || now,
    connectedByUserId: existing?.connectedByUserId || uid || 'system',
    updatedAt: now
  };
  await integrationRef(tenantId).set(doc, { merge: true });
  return doc;
}

async function markDocumentPaid(params: {
  tenantId: string;
  documentId: string;
  sessionId?: string;
  paymentIntentId?: string;
  amountTotal?: number | null;
}) {
  const ref = getAdminDb().doc(`tenants/${params.tenantId}/documents/${params.documentId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn('[stripe] document not found for payment', params);
    return;
  }
  const now = new Date().toISOString();
  await ref.set(
    {
      paymentStatus: 'paid',
      paidAt: now,
      paymentMethod: 'stripe',
      stripeCheckoutSessionId: params.sessionId || null,
      stripePaymentIntentId: params.paymentIntentId || null,
      stripePaidAmountCents:
        typeof params.amountTotal === 'number' ? params.amountTotal : null,
      updatedAt: now
    },
    { merge: true }
  );
}

function mapOutboundPaymentStatus(
  status: string
): 'payment_pending' | 'paid' | 'unpaid' | null {
  const s = status.toLowerCase();
  if (s === 'posted') return 'paid';
  if (s === 'failed' || s === 'canceled' || s === 'cancelled' || s === 'returned') {
    return 'unpaid';
  }
  if (
    s === 'processing' ||
    s === 'awaiting_funds' ||
    s === 'pending' ||
    s === 'approved' ||
    s === 'expected'
  ) {
    return 'payment_pending';
  }
  return null;
}

async function applyOutboundPaymentToBill(params: {
  tenantId: string;
  billId: string;
  paymentId: string;
  stripeStatus: string;
  failureMessage?: string | null;
}) {
  const mapped = mapOutboundPaymentStatus(params.stripeStatus);
  if (!mapped) return;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    stripeOutboundPaymentId: params.paymentId,
    stripeOutboundPaymentStatus: params.stripeStatus,
    updatedAt: now
  };

  if (mapped === 'paid') {
    patch.status = 'paid';
    patch.paidAt = now;
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.paymentId;
    patch.stripePaymentError = null;
  } else if (mapped === 'unpaid') {
    patch.status = 'unpaid';
    patch.paidAt = null;
    patch.stripePaymentError =
      params.failureMessage || `ACH payment ${params.stripeStatus}`;
  } else {
    patch.status = 'payment_pending';
    patch.paymentMethod = 'ach';
    patch.paymentReference = params.paymentId;
    patch.stripePaymentError = null;
  }

  await getAdminDb()
    .doc(`tenants/${params.tenantId}/vendorBills/${params.billId}`)
    .set(patch, { merge: true });
}

async function findBillsByOutboundPayment(tenantId: string, paymentId: string) {
  const snap = await getAdminDb()
    .collection(`tenants/${tenantId}/vendorBills`)
    .where('stripeOutboundPaymentId', '==', paymentId)
    .limit(50)
    .get();
  return snap.docs;
}

function sessionMatchesDocument(
  session: Stripe.Checkout.Session,
  tenantId: string,
  documentId: string
): boolean {
  const metaTenant = String(session.metadata?.tenantId || '');
  const metaDoc = String(session.metadata?.documentId || '');
  if (metaDoc && metaDoc !== documentId) return false;
  if (metaTenant && metaTenant !== tenantId) return false;
  // Prefer explicit metadata match; allow sessions with no metadata only when id was preferred.
  return !metaDoc || metaDoc === documentId;
}

async function retrieveCheckoutSession(
  stripe: Stripe,
  sessionId: string,
  connectedAccountId?: string | null
): Promise<Stripe.Checkout.Session | null> {
  // Destination charges live on the platform account.
  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    // ignore — may be a direct-charge session on the connected account
  }
  if (connectedAccountId) {
    try {
      return await stripe.checkout.sessions.retrieve(
        sessionId,
        { stripeAccount: connectedAccountId }
      );
    } catch {
      // ignore
    }
  }
  return null;
}

async function findPaidCheckoutForDocument(params: {
  stripe: Stripe;
  tenantId: string;
  documentId: string;
  preferredSessionId?: string;
  connectedAccountId?: string | null;
}): Promise<Stripe.Checkout.Session | null> {
  const { stripe, tenantId, documentId, preferredSessionId, connectedAccountId } = params;

  if (preferredSessionId) {
    const preferred = await retrieveCheckoutSession(
      stripe,
      preferredSessionId,
      connectedAccountId
    );
    if (preferred?.payment_status === 'paid' && sessionMatchesDocument(preferred, tenantId, documentId)) {
      return preferred;
    }
  }

  const pools: Array<{ accountId?: string }> = [{}, ...(connectedAccountId ? [{ accountId: connectedAccountId }] : [])];
  for (const pool of pools) {
    try {
      const listed = await stripe.checkout.sessions.list(
        { limit: 100 },
        pool.accountId ? { stripeAccount: pool.accountId } : undefined
      );
      const paid = listed.data.find(
        (s) =>
          s.payment_status === 'paid' &&
          String(s.metadata?.documentId || '') === documentId &&
          String(s.metadata?.tenantId || '') === tenantId
      );
      if (paid) return paid;
    } catch (err) {
      console.warn('[stripe] checkout session list failed', pool.accountId || 'platform', err);
    }
  }

  // Last resort: payment intents with our metadata on the connected account (direct charges).
  if (connectedAccountId) {
    try {
      const intents = await stripe.paymentIntents.list(
        { limit: 100 },
        { stripeAccount: connectedAccountId }
      );
      const paidIntent = intents.data.find(
        (pi) =>
          pi.status === 'succeeded' &&
          String(pi.metadata?.documentId || '') === documentId &&
          String(pi.metadata?.tenantId || '') === tenantId
      );
      if (paidIntent) {
        // Synthesize a minimal session-like object for markDocumentPaid callers.
        return {
          id: preferredSessionId || `pi-fallback-${paidIntent.id}`,
          object: 'checkout.session',
          payment_status: 'paid',
          payment_intent: paidIntent.id,
          amount_total: paidIntent.amount_received || paidIntent.amount,
          metadata: {
            tenantId,
            documentId
          }
        } as unknown as Stripe.Checkout.Session;
      }
    } catch (err) {
      console.warn('[stripe] payment intent list failed', err);
    }
  }

  return null;
}

/**
 * Webhook must be registered BEFORE express.json() so the raw body is preserved
 * for signature verification.
 */
export function registerStripeWebhookRoute(app: Express) {
  app.post(
    '/api/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
      if (!webhookSecret) {
        console.error('[stripe] STRIPE_WEBHOOK_SECRET is not set');
        res.status(503).send('Webhook secret not configured');
        return;
      }
      if (!isFirebaseAdminConfigured()) {
        res.status(503).send('Firebase Admin not configured');
        return;
      }

      const signature = req.headers['stripe-signature'];
      if (!signature || typeof signature !== 'string') {
        res.status(400).send('Missing stripe-signature');
        return;
      }

      let event: Stripe.Event;
      try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
      } catch (err: any) {
        console.error('[stripe] webhook signature failed', err?.message);
        res.status(400).send(`Webhook Error: ${err?.message || 'invalid signature'}`);
        return;
      }

      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session;
          const tenantId = String(session.metadata?.tenantId || '');
          const documentId = String(session.metadata?.documentId || '');
          // Cards are paid immediately. ACH may still be processing here.
          if (tenantId && documentId && session.payment_status === 'paid') {
            const pi =
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id;
            await markDocumentPaid({
              tenantId,
              documentId,
              sessionId: session.id,
              paymentIntentId: pi || undefined,
              amountTotal: session.amount_total
            });
          }
        }

        if (event.type === 'checkout.session.async_payment_succeeded') {
          const session = event.data.object as Stripe.Checkout.Session;
          const tenantId = String(session.metadata?.tenantId || '');
          const documentId = String(session.metadata?.documentId || '');
          if (tenantId && documentId) {
            const pi =
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id;
            await markDocumentPaid({
              tenantId,
              documentId,
              sessionId: session.id,
              paymentIntentId: pi || undefined,
              amountTotal: session.amount_total
            });
          }
        }

        if (event.type === 'checkout.session.async_payment_failed') {
          const session = event.data.object as Stripe.Checkout.Session;
          const tenantId = String(session.metadata?.tenantId || '');
          const documentId = String(session.metadata?.documentId || '');
          if (tenantId && documentId) {
            const ref = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
            await ref.set(
              {
                paymentStatus: 'failed',
                updatedAt: new Date().toISOString()
              },
              { merge: true }
            );
          }
        }

        if (event.type === 'account.updated') {
          const account = event.data.object as Stripe.Account;
          const tenantId = String(account.metadata?.tenantId || '');
          if (tenantId && account.id) {
            await refreshAccountStatus(tenantId, account.id);
          }
        }

        if (
          event.type === 'treasury.outbound_payment.posted' ||
          event.type === 'treasury.outbound_payment.failed' ||
          event.type === 'treasury.outbound_payment.canceled' ||
          event.type === 'treasury.outbound_payment.returned'
        ) {
          const payment = event.data.object as Stripe.Treasury.OutboundPayment;
          const tenantId = String(payment.metadata?.tenantId || '');
          const billIds = String(payment.metadata?.billIds || '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
          const returnedReason = payment.returned_details?.code
            ? String(payment.returned_details.code)
            : '';
          const failMsg =
            payment.status === 'failed'
              ? 'ACH payment failed'
              : payment.status === 'returned'
                ? returnedReason || 'ACH payment returned'
                : payment.status === 'canceled'
                  ? 'ACH payment canceled'
                  : null;
          const targets =
            billIds.length > 0
              ? billIds.map((id) => ({ id }))
              : tenantId
                ? await findBillsByOutboundPayment(tenantId, payment.id)
                : [];
          if (tenantId) {
            for (const doc of targets) {
              await applyOutboundPaymentToBill({
                tenantId,
                billId: doc.id,
                paymentId: payment.id,
                stripeStatus: String(payment.status || ''),
                failureMessage: failMsg
              });
            }
          }
        }

        res.json({ received: true });
      } catch (err: any) {
        console.error('[stripe] webhook handler failed', err);
        res.status(500).json({ error: err?.message || 'Webhook handler failed' });
      }
    }
  );
}

export function registerStripeRoutes(app: Express) {
  app.get('/api/stripe/config-status', (_req, res) => {
    const secret = process.env.STRIPE_SECRET_KEY?.trim() || '';
    res.json({
      configured: isStripeConfigured() && isFirebaseAdminConfigured(),
      stripe: isStripeConfigured(),
      firebaseAdmin: isFirebaseAdminConfigured(),
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() || null,
      testMode: secret.startsWith('sk_test_')
    });
  });

  app.get('/api/stripe/status', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.query.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      let integration = await loadIntegration(tenantId);
      if (integration?.accountId && isStripeConfigured()) {
        try {
          integration = await refreshAccountStatus(tenantId, integration.accountId, uid);
        } catch (err) {
          console.warn('[stripe] status refresh failed', err);
        }
      }

      let treasuryPlatformAccess: boolean | null = null;
      let platformAccountId: string | null = null;
      let platformAccountName: string | null = null;
      let platformKeyHint: string | null = null;
      if (isStripeConfigured()) {
        try {
          const stripe = getStripe();
          const platform = await retrievePlatformAccount(stripe);
          platformAccountId = platform.id;
          platformAccountName = platform.name;
          platformKeyHint = keyHint();
          if (requireStripeSecret().startsWith('sk_test_')) {
            treasuryPlatformAccess = await platformHasTreasuryAccess(stripe);
          }
        } catch (err) {
          console.warn('[stripe] platform status probe failed', err);
          treasuryPlatformAccess = null;
        }
      }

      res.json({
        connected: Boolean(integration?.accountId),
        accountId: integration?.accountId || null,
        chargesEnabled: Boolean(integration?.chargesEnabled),
        detailsSubmitted: Boolean(integration?.detailsSubmitted),
        payoutsEnabled: Boolean(integration?.payoutsEnabled),
        connectedAt: integration?.connectedAt || null,
        accountKind: integration?.accountKind || null,
        treasuryCapability: integration?.treasuryCapability || 'unrequested',
        financialAccountId: integration?.financialAccountId || null,
        financialAccountStatus: integration?.financialAccountStatus || null,
        treasuryReady:
          integration?.treasuryCapability === 'active' &&
          Boolean(integration?.financialAccountId),
        treasuryPlatformAccess,
        treasuryActivateUrl: TREASURY_ACTIVATE_URL,
        platformAccountId,
        platformAccountName,
        platformKeyHint,
        configured: isStripeConfigured() && isFirebaseAdminConfigured(),
        testMode: isStripeConfigured() && requireStripeSecret().startsWith('sk_test_')
      });
    })
  );

  /** Lightweight flag for Purchasing ACH — office can pay bills but not manage Connect. */
  app.get('/api/stripe/treasury-ready', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.query.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      res.json({
        treasuryReady:
          integration?.treasuryCapability === 'active' &&
          Boolean(integration?.financialAccountId),
        connected: Boolean(integration?.accountId)
      });
    })
  );

  app.post('/api/stripe/connect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      if (!isFirebaseAdminConfigured()) {
        throw Object.assign(new Error('Firebase Admin is not configured on the server.'), {
          status: 503
        });
      }

      const stripe = getStripe();
      let integration = await loadIntegration(tenantId);
      let accountId = integration?.accountId;
      const isTestMode = requireStripeSecret().startsWith('sk_test_');

      const tenantSnap = await getAdminDb().doc(`tenants/${tenantId}`).get();
      const tenantName = String(tenantSnap.data()?.name || 'Nursery');
      const memberSnap = await getAdminDb().doc(`tenants/${tenantId}/members/${uid}`).get();
      const email = String(memberSnap.data()?.email || '');

      // Sandbox: drop incomplete Express accounts that are stuck on hosted SSN.
      if (isTestMode && accountId && !integration?.chargesEnabled) {
        try {
          await stripe.accounts.del(accountId);
        } catch (err) {
          console.warn('[stripe] test-mode account delete failed', err);
        }
        await integrationRef(tenantId).delete();
        accountId = undefined;
        integration = null;
      }

      if (!accountId) {
        if (isTestMode) {
          const treasuryOk = await platformHasTreasuryAccess(stripe);
          // Skip Express hosted KYC entirely — Custom + API test tokens.
          let account: Stripe.Account;
          try {
            account = await createSandboxReadyAccount(stripe, {
              tenantId,
              tenantName,
              email: email || undefined,
              ip: clientIp(req),
              withTreasury: treasuryOk
            });
          } catch (err) {
            if (isUnknownTreasuryCapabilityError(err)) {
              account = await createSandboxReadyAccount(stripe, {
                tenantId,
                tenantName,
                email: email || undefined,
                ip: clientIp(req),
                withTreasury: false
              });
            } else {
              throw err;
            }
          }
          accountId = account.id;
          integration = await refreshAccountStatus(tenantId, accountId, uid);
          if (!integration.chargesEnabled) {
            const due = (account.requirements?.currently_due || []).join(', ');
            throw Object.assign(
              new Error(
                `Sandbox Stripe account created but charges are not enabled yet${
                  due ? ` (still due: ${due})` : ''
                }. Check Stripe Dashboard → Connect.`
              ),
              { status: 502 }
            );
          }
          res.json({
            accountId,
            onboardingUrl: null,
            chargesEnabled: true,
            detailsSubmitted: Boolean(integration.detailsSubmitted),
            treasuryReady:
              integration.treasuryCapability === 'active' &&
              Boolean(integration.financialAccountId),
            treasuryPlatformAccess: treasuryOk,
            testMode: true
          });
          return;
        }

        // Live: Custom + Account Links (platform-managed; required for Treasury).
        // Do not prefill business_profile.url with the platform origin — Stripe
        // crawls that URL for verification, and bot-blocking CDNs often 403 it.
        let account: Stripe.Account;
        try {
          account = await stripe.accounts.create({
            type: 'custom',
            country: 'US',
            email: email || undefined,
            capabilities: { ...CONNECT_CAPABILITIES },
            business_profile: {
              name: tenantName,
              product_description: `${tenantName} nursery wholesale and plant orders`
            },
            metadata: { tenantId, nurseryos: '1' }
          });
        } catch (err) {
          if (!isUnknownTreasuryCapabilityError(err)) throw err;
          account = await stripe.accounts.create({
            type: 'custom',
            country: 'US',
            email: email || undefined,
            capabilities: { ...BASE_CONNECT_CAPABILITIES },
            business_profile: {
              name: tenantName,
              product_description: `${tenantName} nursery wholesale and plant orders`
            },
            metadata: { tenantId, nurseryos: '1' }
          });
        }
        accountId = account.id;
        integration = await refreshAccountStatus(tenantId, accountId, uid);
      }

      const link = await stripe.accountLinks.create({
        account: accountId!,
        refresh_url: `${appOrigin()}/?stripe=refresh`,
        return_url: `${appOrigin()}/?stripe=return`,
        type: 'account_onboarding'
      });

      res.json({
        accountId,
        onboardingUrl: link.url,
        chargesEnabled: Boolean(integration?.chargesEnabled),
        detailsSubmitted: Boolean(integration?.detailsSubmitted),
        testMode: isTestMode
      });
    })
  );

  app.post('/api/stripe/disconnect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      const existing = await loadIntegration(tenantId);
      if (existing?.accountId && isStripeConfigured()) {
        try {
          const stripe = getStripe();
          await stripe.accounts.del(existing.accountId);
        } catch (err) {
          console.warn('[stripe] disconnect account delete failed', err);
        }
      }
      await integrationRef(tenantId).delete();
      res.json({ success: true });
    })
  );

  /**
   * Request Treasury + create FinancialAccount on an existing connected account.
   * Express accounts cannot use Treasury — reconnect creates a platform-managed account.
   */
  app.post('/api/stripe/enable-treasury', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      if (!isFirebaseAdminConfigured()) {
        throw Object.assign(new Error('Firebase Admin is not configured on the server.'), {
          status: 503
        });
      }

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        throw Object.assign(new Error('Connect Stripe for this nursery first.'), { status: 400 });
      }

      const stripe = getStripe();
      const account = await stripe.accounts.retrieve(integration.accountId);
      const kind = accountKindFromStripe(account);
      if (kind === 'express') {
        throw Object.assign(
          new Error(
            'This nursery uses an Express Stripe account, which cannot use Treasury (vendor ACH). Disconnect Stripe in Team, then Connect again to create a platform-managed account with Treasury.'
          ),
          { status: 400 }
        );
      }

      try {
        await stripe.accounts.update(integration.accountId, {
          capabilities: {
            treasury: { requested: true },
            us_bank_account_ach_payments: { requested: true }
          }
        });
      } catch (err: any) {
        if (isUnknownTreasuryCapabilityError(err)) {
          const platform = await retrievePlatformAccount(stripe).catch(() => undefined);
          throw treasuryNotActivatedError(platform);
        }
        throw Object.assign(
          new Error(err?.message || 'Could not request Treasury on this Stripe account.'),
          { status: 400 }
        );
      }

      // Sandbox Custom: accept Treasury TOS via API so capability can activate without hosted form.
      if (requireStripeSecret().startsWith('sk_test_')) {
        try {
          await stripe.accounts.update(integration.accountId, {
            settings: {
              treasury: {
                tos_acceptance: {
                  date: Math.floor(Date.now() / 1000),
                  ip: clientIp(req)
                }
              }
            }
          });
        } catch (err) {
          console.warn('[stripe] sandbox treasury TOS accept failed', err);
        }
      }

      const refreshed = await refreshAccountStatus(tenantId, integration.accountId, uid);
      let onboardingUrl: string | null = null;
      if (refreshed.treasuryCapability !== 'active') {
        const link = await stripe.accountLinks.create({
          account: integration.accountId,
          refresh_url: `${appOrigin()}/?stripe=refresh`,
          return_url: `${appOrigin()}/?stripe=return`,
          type: 'account_onboarding'
        });
        onboardingUrl = link.url;
      }

      res.json({
        accountId: refreshed.accountId,
        treasuryCapability: refreshed.treasuryCapability,
        financialAccountId: refreshed.financialAccountId || null,
        financialAccountStatus: refreshed.financialAccountStatus || null,
        treasuryReady:
          refreshed.treasuryCapability === 'active' && Boolean(refreshed.financialAccountId),
        onboardingUrl
      });
    })
  );

  /**
   * Sandbox-only one-shot: wipe connected account, create Custom + Treasury + FA,
   * and fund $1,000 test balance so vendor ACH can be tried immediately.
   */
  app.post('/api/stripe/sandbox-onboard-treasury', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '').trim();
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      if (!isFirebaseAdminConfigured()) {
        throw Object.assign(new Error('Firebase Admin is not configured on the server.'), {
          status: 503
        });
      }
      if (!requireStripeSecret().startsWith('sk_test_')) {
        throw Object.assign(
          new Error('Sandbox Treasury onboard only works with sk_test_ keys.'),
          { status: 400 }
        );
      }

      const stripe = getStripe();
      treasuryAccessCache = null; // force fresh probe
      const platform = await retrievePlatformAccount(stripe);
      const hasAccess = await platformHasTreasuryAccess(stripe);
      if (!hasAccess) {
        throw treasuryNotActivatedError(platform);
      }

      const existing = await loadIntegration(tenantId);
      if (existing?.accountId) {
        try {
          await stripe.accounts.del(existing.accountId);
        } catch (err) {
          console.warn('[stripe] sandbox onboard delete failed', err);
        }
        await integrationRef(tenantId).delete();
      }

      const tenantSnap = await getAdminDb().doc(`tenants/${tenantId}`).get();
      const tenantName = String(tenantSnap.data()?.name || 'Nursery');
      const memberSnap = await getAdminDb().doc(`tenants/${tenantId}/members/${uid}`).get();
      const email = String(memberSnap.data()?.email || '');

      let account: Stripe.Account;
      try {
        account = await createSandboxReadyAccount(stripe, {
          tenantId,
          tenantName,
          email: email || undefined,
          ip: clientIp(req),
          withTreasury: true
        });
      } catch (err) {
        if (isUnknownTreasuryCapabilityError(err)) {
          throw treasuryNotActivatedError(platform);
        }
        throw err;
      }

      let integration = await refreshAccountStatus(tenantId, account.id, uid);

      // Poll briefly for treasury capability to flip active
      for (let i = 0; i < 5 && integration.treasuryCapability !== 'active'; i++) {
        await new Promise((r) => setTimeout(r, 800));
        integration = await refreshAccountStatus(tenantId, account.id, uid);
      }

      if (integration.treasuryCapability !== 'active') {
        throw Object.assign(
          new Error(
            `Sandbox account created but treasury capability is still "${integration.treasuryCapability}". ` +
              `Check Stripe Dashboard → Connect → ${account.id} → Capabilities, and finish any due requirements.`
          ),
          { status: 502 }
        );
      }

      if (!integration.financialAccountId) {
        try {
          const fa = await ensureFinancialAccount(stripe, account.id, null);
          if (fa) {
            await integrationRef(tenantId).set(
              {
                financialAccountId: fa.id,
                financialAccountStatus: fa.status,
                updatedAt: new Date().toISOString()
              },
              { merge: true }
            );
            integration = {
              ...integration,
              financialAccountId: fa.id,
              financialAccountStatus: fa.status
            };
          }
        } catch (err: any) {
          throw Object.assign(
            new Error(err?.message || 'Could not create Financial Account.'),
            { status: 502 }
          );
        }
      }

      let fundedCents: number | null = null;
      if (integration.financialAccountId) {
        fundedCents = await fundSandboxFinancialAccount(
          stripe,
          account.id,
          integration.financialAccountId,
          100_000
        );
      }

      res.json({
        accountId: account.id,
        chargesEnabled: Boolean(integration.chargesEnabled),
        treasuryCapability: integration.treasuryCapability,
        financialAccountId: integration.financialAccountId || null,
        treasuryReady:
          integration.treasuryCapability === 'active' &&
          Boolean(integration.financialAccountId),
        fundedCents,
        testMode: true
      });
    })
  );

  app.post('/api/stripe/create-checkout', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const documentId = String(req.body?.documentId || '');
      if (!tenantId || !documentId) {
        res.status(400).json({ error: 'tenantId and documentId are required.' });
        return;
      }
      await assertCanCreatePayLink(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        throw Object.assign(
          new Error('Connect Stripe for this nursery in Team settings first.'),
          { status: 400 }
        );
      }
      if (!integration.chargesEnabled) {
        throw Object.assign(
          new Error(
            'Stripe onboarding is incomplete. Finish Connect setup in Team, then try again.'
          ),
          { status: 400 }
        );
      }

      const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
      const snap = await docRef.get();
      if (!snap.exists) {
        throw Object.assign(new Error('Invoice/estimate document not found.'), { status: 404 });
      }
      const doc = snap.data() || {};
      if (doc.type !== 'invoice') {
        throw Object.assign(new Error('Only invoices can be collected via Stripe.'), {
          status: 400
        });
      }

      const grandTotal = Number(doc.grandTotal);
      if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
        throw Object.assign(new Error('Invoice total must be greater than $0.'), { status: 400 });
      }
      const amountCents = Math.round(grandTotal * 100);
      if (amountCents < 50) {
        throw Object.assign(new Error('Stripe requires a minimum charge of $0.50.'), {
          status: 400
        });
      }

      const docNumber = String(doc.documentNumber || documentId);
      const customerName = String(doc.billToName || doc.customerName || 'Customer');
      const customerEmail = String(doc.customerEmail || '').trim();

      const stripe = getStripe();
      // Direct charges on the connected nursery account (SaaS Connect).
      // Destination charges + transfer_data conflict with Stripe Managed Payments
      // (default on some platforms). Keep confirm-payment + Connected-account webhooks
      // to mark invoices paid.
      // Ensure ACH capability on existing Express accounts (Dashboard enable alone isn't enough).
      try {
        await stripe.accounts.update(integration.accountId, {
          capabilities: {
            us_bank_account_ach_payments: { requested: true }
          }
        });
      } catch (err) {
        console.warn('[stripe] could not request ACH capability', integration.accountId, err);
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          // Explicit types so ACH appears for Connect direct charges (dynamic PM alone can hide it).
          payment_method_types: ['card', 'us_bank_account'],
          payment_method_options: {
            us_bank_account: {
              financial_connections: {
                permissions: ['payment_method']
              },
              verification_method: 'automatic'
            }
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: amountCents,
                product_data: {
                  name: `Invoice ${docNumber}`,
                  description: `Payment for ${customerName}`.slice(0, 500)
                }
              }
            }
          ],
          // {CHECKOUT_SESSION_ID} is replaced by Stripe on redirect — used to sync paid status
          // even if the webhook endpoint is delayed or misconfigured.
          success_url: `${appOrigin()}/?stripe_pay=success&documentId=${encodeURIComponent(documentId)}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appOrigin()}/?stripe_pay=cancel&documentId=${encodeURIComponent(documentId)}`,
          customer_email: customerEmail || undefined,
          metadata: {
            tenantId,
            documentId,
            documentNumber: docNumber
          },
          payment_intent_data: {
            metadata: {
              tenantId,
              documentId,
              documentNumber: docNumber
            }
          }
        },
        { stripeAccount: integration.accountId }
      );

      const now = new Date().toISOString();
      await docRef.set(
        {
          paymentStatus: 'pending',
          stripeCheckoutSessionId: session.id,
          stripeCheckoutUrl: session.url || null,
          stripeConnectedAccountId: integration.accountId,
          updatedAt: now
        },
        { merge: true }
      );

      res.json({
        url: session.url,
        sessionId: session.id,
        accountId: integration.accountId
      });
    })
  );

  /**
   * Sync paid status from Stripe when webhooks are delayed/missing.
   * Supports both destination charges (platform session) and older direct-charge sessions.
   */
  app.post('/api/stripe/confirm-payment', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const documentId = String(req.body?.documentId || '');
      const sessionId = String(req.body?.sessionId || '').trim();
      if (!tenantId || !documentId) {
        res.status(400).json({ error: 'tenantId and documentId are required.' });
        return;
      }
      await assertCanCreatePayLink(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        throw Object.assign(new Error('Stripe is not connected for this nursery.'), {
          status: 400
        });
      }

      const docRef = getAdminDb().doc(`tenants/${tenantId}/documents/${documentId}`);
      const snap = await docRef.get();
      if (!snap.exists) {
        throw Object.assign(new Error('Invoice document not found.'), { status: 404 });
      }
      const doc = snap.data() || {};
      if (doc.paymentStatus === 'paid') {
        res.json({
          paid: true,
          alreadyPaid: true,
          paidAt: doc.paidAt || null
        });
        return;
      }

      const connectedAccountId =
        String(doc.stripeConnectedAccountId || integration.accountId || '') || null;
      const checkoutSessionId = sessionId || String(doc.stripeCheckoutSessionId || '');

      const stripe = getStripe();
      const session = await findPaidCheckoutForDocument({
        stripe,
        tenantId,
        documentId,
        preferredSessionId: checkoutSessionId || undefined,
        connectedAccountId
      });

      if (!session || session.payment_status !== 'paid') {
        const preferred = checkoutSessionId
          ? await retrieveCheckoutSession(stripe, checkoutSessionId, connectedAccountId)
          : null;
        res.json({
          paid: false,
          paymentStatus: preferred?.payment_status || 'unpaid',
          sessionStatus: preferred?.status || null,
          hint:
            'No paid Checkout/PaymentIntent found for this invoice yet. Create a new pay link after this deploy, complete payment, then Refresh again.'
        });
        return;
      }

      const pi =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;

      await markDocumentPaid({
        tenantId,
        documentId,
        sessionId: session.id?.startsWith('cs_') ? session.id : checkoutSessionId || session.id,
        paymentIntentId: pi || undefined,
        amountTotal: session.amount_total
      });

      res.json({
        paid: true,
        alreadyPaid: false,
        sessionId: session.id,
        amountTotal: session.amount_total
      });
    })
  );

  app.post('/api/stripe/pay-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
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

      if (!tenantId || billIds.length === 0) {
        res.status(400).json({ error: 'tenantId and billId(s) are required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        throw Object.assign(new Error('Connect Stripe for this nursery in Team settings first.'), {
          status: 400
        });
      }
      if (integration.treasuryCapability !== 'active' || !integration.financialAccountId) {
        throw Object.assign(
          new Error(
            'Stripe Treasury is not ready. In Team → Stripe, enable vendor ACH (Treasury) and finish onboarding.'
          ),
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
        stripeOutboundPaymentId?: string;
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
        if (
          bill.status === 'payment_pending' &&
          (bill.stripeOutboundPaymentId || bill.checkbookPaymentId)
        ) {
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
      if (vendorIds.length !== 1) {
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
      const amountCents = Math.round(amount * 100);
      if (amountCents < 1) {
        throw Object.assign(new Error('Payment amount is too small.'), { status: 400 });
      }

      const vendorId = vendorIds[0];
      const vendorSnap = await getAdminDb().doc(`tenants/${tenantId}/vendors/${vendorId}`).get();
      if (!vendorSnap.exists) {
        throw Object.assign(new Error('Vendor not found.'), { status: 404 });
      }
      const vendor = vendorSnap.data() as {
        name?: string;
        bankRoutingNumber?: string;
        bankAccountNumber?: string;
        bankAccountLast4?: string;
        bankAccountHolderName?: string;
        bankAccountType?: string;
        contactName?: string;
      };

      const routing = String(vendor.bankRoutingNumber || '').replace(/\D/g, '');
      const accountNumber = String(vendor.bankAccountNumber || '').replace(/\s/g, '');
      if (routing.length !== 9 || accountNumber.length < 4) {
        throw Object.assign(
          new Error(
            'Add the vendor’s bank routing and account numbers in Purchasing → Vendors before paying via ACH.'
          ),
          { status: 400 }
        );
      }

      const vendorName = String(vendor.name || bills[0]?.vendorName || 'Vendor');
      const holderName = String(
        vendor.bankAccountHolderName || vendor.contactName || vendorName
      ).trim();
      const accountType =
        String(vendor.bankAccountType || 'checking').toLowerCase() === 'savings'
          ? 'savings'
          : 'checking';
      const last4 =
        String(vendor.bankAccountLast4 || '').replace(/\D/g, '').slice(-4) ||
        accountNumber.replace(/\D/g, '').slice(-4);

      const billNumbers = bills
        .map((b) => String(b.billNumber || b.id).trim())
        .filter(Boolean)
        .slice(0, 6);
      const description =
        bills.length === 1
          ? `Bill ${billNumbers[0] || bills[0].id}`.slice(0, 500)
          : `Bills ${billNumbers.join(', ')}${
              bills.length > billNumbers.length ? '…' : ''
            }`.slice(0, 500);

      const stripe = getStripe();
      const opts = { stripeAccount: integration.accountId };

      let outbound: Stripe.Treasury.OutboundPayment;
      try {
        outbound = await stripe.treasury.outboundPayments.create(
          {
            financial_account: integration.financialAccountId,
            amount: amountCents,
            currency: 'usd',
            description,
            statement_descriptor: 'VENDORACH',
            destination_payment_method_data: {
              type: 'us_bank_account',
              us_bank_account: {
                routing_number: routing,
                account_number: accountNumber,
                account_holder_type: 'company',
                account_type: accountType
              },
              billing_details: {
                name: holderName.slice(0, 200)
              }
            },
            destination_payment_method_options: {
              us_bank_account: {
                network: 'ach'
              }
            },
            end_user_details: {
              present: true,
              ip_address: clientIp(req)
            },
            metadata: {
              tenantId,
              billIds: billIds.join(',').slice(0, 450),
              nurseryos: '1'
            }
          },
          opts
        );
      } catch (err: any) {
        const msg = String(err?.message || 'Stripe ACH payment failed.');
        throw Object.assign(
          new Error(
            /insufficient|balance|funds/i.test(msg)
              ? `${msg} Fund this nursery’s Stripe Financial Account (Treasury) before paying vendors.`
              : msg
          ),
          { status: 400 }
        );
      }

      const now = new Date().toISOString();
      const batch = getAdminDb().batch();
      for (const bill of bills) {
        batch.set(
          getAdminDb().doc(`tenants/${tenantId}/vendorBills/${bill.id}`),
          {
            status: 'payment_pending',
            paymentMethod: 'ach',
            paymentReference: outbound.id,
            stripeOutboundPaymentId: outbound.id,
            stripeOutboundPaymentStatus: outbound.status || 'processing',
            stripeAchLast4: last4 || null,
            stripePaymentError: null,
            checkbookPaymentError: null,
            updatedAt: now
          },
          { merge: true }
        );
      }
      await batch.commit();

      // If Stripe already posted (rare/fast sandbox), apply immediately
      if (outbound.status === 'posted') {
        for (const bill of bills) {
          await applyOutboundPaymentToBill({
            tenantId,
            billId: bill.id,
            paymentId: outbound.id,
            stripeStatus: 'posted'
          });
        }
      }

      res.json({
        paymentId: outbound.id,
        status: outbound.status,
        amount: amountCents / 100,
        billIds,
        billCount: bills.length,
        vendorName,
        last4: last4 || null,
        provider: 'stripe'
      });
    })
  );

  app.post('/api/stripe/refresh-bill', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '').trim();
      const billId = String(req.body?.billId || '').trim();
      if (!tenantId || !billId) {
        res.status(400).json({ error: 'tenantId and billId are required.' });
        return;
      }
      await assertCanPayVendorBills(tenantId, uid);

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        throw Object.assign(new Error('Stripe is not connected for this nursery.'), {
          status: 400
        });
      }

      const billRef = getAdminDb().doc(`tenants/${tenantId}/vendorBills/${billId}`);
      const billSnap = await billRef.get();
      if (!billSnap.exists) {
        throw Object.assign(new Error('Vendor bill not found.'), { status: 404 });
      }
      const bill = billSnap.data() as {
        stripeOutboundPaymentId?: string;
      };
      const paymentId = String(bill.stripeOutboundPaymentId || '').trim();
      if (!paymentId) {
        throw Object.assign(new Error('This bill has no Stripe ACH payment to refresh.'), {
          status: 400
        });
      }

      const stripe = getStripe();
      const payment = await stripe.treasury.outboundPayments.retrieve(paymentId, {
        stripeAccount: integration.accountId
      });

      await applyOutboundPaymentToBill({
        tenantId,
        billId,
        paymentId: payment.id,
        stripeStatus: String(payment.status || ''),
        failureMessage:
          payment.status === 'failed'
            ? 'ACH payment failed'
            : payment.status === 'returned'
              ? String(payment.returned_details?.code || 'ACH payment returned')
              : null
      });

      res.json({
        paymentId: payment.id,
        status: payment.status,
        provider: 'stripe'
      });
    })
  );
}
