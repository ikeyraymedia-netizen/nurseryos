import type { Express, Request, Response } from 'express';
import Stripe from 'stripe';
import {
  getAdminDb,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

function requireStripeSecret(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw Object.assign(
      new Error('Stripe is not configured. Set STRIPE_SECRET_KEY on the server.'),
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

async function readBearerUid(req: Request): Promise<string> {
  if (!isFirebaseAdminConfigured()) {
    throw Object.assign(new Error('Firebase Admin not configured.'), { status: 503 });
  }
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Sign in required.'), { status: 401 });
  const decoded = await verifyFirebaseIdToken(match[1]);
  return decoded.uid;
}

function httpError(res: Response, err: unknown) {
  const status = typeof (err as any)?.status === 'number' ? (err as any).status : 500;
  const message = (err as any)?.message || 'Internal error';
  res.status(status).json({ error: message });
}

async function withAuth(req: Request, res: Response, fn: (uid: string) => Promise<void>) {
  try {
    const uid = await readBearerUid(req);
    await fn(uid);
  } catch (err: any) {
    httpError(res, err);
  }
}

interface StripeIntegration {
  accountId: string;
  chargesEnabled: boolean;
}

async function loadIntegration(tenantId: string): Promise<StripeIntegration | null> {
  const snap = await getAdminDb().doc(`tenants/${tenantId}/integrations/stripe`).get();
  if (!snap.exists) return null;
  return snap.data() as StripeIntegration;
}

export function registerTerminalRoutes(app: Express) {
  /**
   * POST /api/terminal/connection-token
   * Returns a connection token for the Stripe Terminal JS SDK.
   * The SDK needs a fresh token each time it connects to a reader.
   */
  app.post('/api/terminal/connection-token', (req, res) =>
    withAuth(req, res, async () => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        res.status(400).json({ error: 'Stripe is not connected for this nursery.' });
        return;
      }

      const stripe = getStripe();
      const token = await stripe.terminal.connectionTokens.create(
        {},
        { stripeAccount: integration.accountId }
      );

      res.json({ secret: token.secret });
    })
  );

  /**
   * POST /api/terminal/create-payment-intent
   * Creates a PaymentIntent for an in-person card_present payment.
   */
  app.post('/api/terminal/create-payment-intent', (req, res) =>
    withAuth(req, res, async () => {
      const { tenantId, amountCents, customerName, cartSummary } = req.body || {};
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      if (!amountCents || typeof amountCents !== 'number' || amountCents < 50) {
        res.status(400).json({ error: 'amountCents must be at least 50 ($0.50).' });
        return;
      }

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        res.status(400).json({ error: 'Stripe is not connected for this nursery.' });
        return;
      }

      const stripe = getStripe();
      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: Math.round(amountCents),
          currency: 'usd',
          payment_method_types: ['card_present'],
          capture_method: 'automatic',
          description: `Retail POS · ${customerName || 'Walk-in Customer'}`,
          metadata: {
            tenantId,
            source: 'retail_pos',
            customerName: String(customerName || 'Walk-in Customer').slice(0, 500),
            cartSummary: String(cartSummary || '').slice(0, 500)
          }
        },
        { stripeAccount: integration.accountId }
      );

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    })
  );

  /**
   * POST /api/terminal/capture-payment
   * Captures a PaymentIntent after the reader collects the card.
   * For automatic capture this is a no-op confirmation check.
   */
  app.post('/api/terminal/capture-payment', (req, res) =>
    withAuth(req, res, async () => {
      const { tenantId, paymentIntentId } = req.body || {};
      if (!tenantId || !paymentIntentId) {
        res.status(400).json({ error: 'tenantId and paymentIntentId are required.' });
        return;
      }

      const integration = await loadIntegration(tenantId);
      if (!integration?.accountId) {
        res.status(400).json({ error: 'Stripe is not connected for this nursery.' });
        return;
      }

      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(
        paymentIntentId,
        { stripeAccount: integration.accountId }
      );

      res.json({
        status: pi.status,
        amountReceived: pi.amount_received,
        paymentIntentId: pi.id
      });
    })
  );
}
