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
  connectedAt: string;
  connectedByUserId: string;
  updatedAt: string;
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
  if (!hasAnyRole(roles, ['owner', 'admin', 'office'])) {
    throw Object.assign(new Error('You do not have permission to create payment links.'), {
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
  const doc: StripeIntegration = {
    provider: 'stripe',
    accountId,
    chargesEnabled: Boolean(account.charges_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    payoutsEnabled: Boolean(account.payouts_enabled),
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
      stripeCheckoutSessionId: params.sessionId || null,
      stripePaymentIntentId: params.paymentIntentId || null,
      stripePaidAmountCents:
        typeof params.amountTotal === 'number' ? params.amountTotal : null,
      updatedAt: now
    },
    { merge: true }
  );
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

        if (event.type === 'account.updated') {
          const account = event.data.object as Stripe.Account;
          const tenantId = String(account.metadata?.tenantId || '');
          if (tenantId && account.id) {
            await refreshAccountStatus(tenantId, account.id);
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
    res.json({
      configured: isStripeConfigured() && isFirebaseAdminConfigured(),
      stripe: isStripeConfigured(),
      firebaseAdmin: isFirebaseAdminConfigured(),
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() || null
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

      res.json({
        connected: Boolean(integration?.accountId),
        accountId: integration?.accountId || null,
        chargesEnabled: Boolean(integration?.chargesEnabled),
        detailsSubmitted: Boolean(integration?.detailsSubmitted),
        payoutsEnabled: Boolean(integration?.payoutsEnabled),
        connectedAt: integration?.connectedAt || null,
        configured: isStripeConfigured() && isFirebaseAdminConfigured()
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

      if (!accountId) {
        const tenantSnap = await getAdminDb().doc(`tenants/${tenantId}`).get();
        const tenantName = String(tenantSnap.data()?.name || 'Nursery');
        const memberSnap = await getAdminDb().doc(`tenants/${tenantId}/members/${uid}`).get();
        const email = String(memberSnap.data()?.email || '');

        // SaaS Connect: nursery is merchant of record; Stripe owns pricing/losses.
        // Express + Account Links is the reliable Phase-1 onboarding path.
        // Do not prefill business_profile.url with the platform origin — Stripe
        // crawls that URL for verification, and bot-blocking CDNs often 403 it
        // (surfaced in onboarding as "Native fetch error: Failed to fetch").
        // Test mode: use Stripe's accessible test site. Live: let the nursery
        // enter their own site, with product_description as a fallback.
        const isTestMode = requireStripeSecret().startsWith('sk_test_');
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: email || undefined,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }
          },
          business_profile: {
            name: tenantName,
            product_description: `${tenantName} nursery wholesale and plant orders`,
            ...(isTestMode ? { url: 'https://accessible.stripe.com' } : {})
          },
          metadata: { tenantId, nurseryos: '1' }
        });
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
        detailsSubmitted: Boolean(integration?.detailsSubmitted)
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
      await integrationRef(tenantId).delete();
      res.json({ success: true });
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
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
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
}
