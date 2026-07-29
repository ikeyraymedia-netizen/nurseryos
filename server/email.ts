import type { Express, Request, Response } from 'express';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { createAccessRequestDoc } from './platform';

interface EmailIntegration {
  /** reply-to / customer-facing nursery contact email */
  fromName: string;
  fromEmail: string;
  configuredAt: string;
  configuredByUserId: string;
  updatedAt: string;
  /** legacy fields kept so older docs still load */
  provider?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

function integrationRef(tenantId: string) {
  return getAdminDb().doc(`tenants/${tenantId}/integrations/email`);
}

async function loadIntegration(tenantId: string): Promise<EmailIntegration | null> {
  const snap = await integrationRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() as EmailIntegration;
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
    throw Object.assign(new Error('Only owners and admins can manage outbound email.'), {
      status: 403
    });
  }
}

async function assertCanSendInvoice(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin', 'office', 'sales'])) {
    throw Object.assign(new Error('You do not have permission to email invoices.'), {
      status: 403
    });
  }
}

function httpError(res: Response, err: any) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[email]', err);
  res.status(status).json({
    error: err?.message || 'Email request failed.'
  });
}

function withAuth(req: Request, res: Response, fn: (uid: string) => Promise<void>) {
  void (async () => {
    try {
      if (!isFirebaseAdminConfigured()) {
        throw Object.assign(
          new Error('Firebase Admin is not configured on the server.'),
          { status: 503 }
        );
      }
      const uid = await readBearerUid(req);
      await fn(uid);
    } catch (err: any) {
      httpError(res, err);
    }
  })();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function platformFromAddress(): string {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  // Resend test sender works immediately; replace with a verified domain in production.
  return configured || 'NurseryOS <onboarding@resend.dev>';
}

async function sendViaResend(params: {
  fromName: string;
  replyTo: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error(
        'Email sending is not configured on the server. Add RESEND_API_KEY (and optionally RESEND_FROM_EMAIL) in Railway.'
      ),
      { status: 503, code: 'RESEND_NOT_CONFIGURED' }
    );
  }

  const safeName = params.fromName.replace(/"/g, '').trim() || 'Nursery';
  const platform = platformFromAddress();
  const match = platform.match(/<([^>]+)>/);
  const fromAddress = match?.[1] || (looksLikeEmail(platform) ? platform : 'onboarding@resend.dev');
  const fromHeader = `${safeName} <${fromAddress}>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromHeader,
      to: [params.to],
      reply_to: params.replyTo,
      subject: params.subject,
      text: params.text,
      html: params.html
    })
  });

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    error?: { message?: string };
  };

  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `Resend error (${res.status})`;
    throw Object.assign(new Error(detail), { status: 502 });
  }

  return String(data.id || '');
}

export async function sendTenantInvoiceEmail(params: {
  tenantId: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromNameOverride?: string;
}): Promise<{ messageId: string; fromEmail: string; fromName: string }> {
  const integration = await loadIntegration(params.tenantId);
  if (!integration?.fromEmail) {
    throw Object.assign(
      new Error(
        'This nursery has not configured outbound email yet. Open Team → Outbound email and add the nursery’s reply-to address.'
      ),
      { status: 400, code: 'TENANT_SMTP_NOT_CONFIGURED' }
    );
  }

  const fromName = (params.fromNameOverride || integration.fromName || '').trim() || 'Nursery';
  const replyTo = integration.fromEmail.trim();

  const messageId = await sendViaResend({
    fromName,
    replyTo,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html
  });

  return {
    messageId,
    fromEmail: replyTo,
    fromName
  };
}

export function registerEmailRoutes(app: Express) {
  app.get('/api/email/status', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.query.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertCanSendInvoice(tenantId, uid);
      const integration = await loadIntegration(tenantId);
      res.json({
        configured: Boolean(integration?.fromEmail),
        platformReady: isResendConfigured(),
        fromEmail: integration?.fromEmail || null,
        fromName: integration?.fromName || null,
        configuredAt: integration?.configuredAt || null
      });
    })
  );

  app.post('/api/email/config', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const fromEmail = String(req.body?.fromEmail || '').trim();
      const fromName = String(req.body?.fromName || '').trim();

      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      if (!looksLikeEmail(fromEmail)) {
        res.status(400).json({ error: 'Enter a valid reply-to email address.' });
        return;
      }

      const existing = await loadIntegration(tenantId);
      const now = new Date().toISOString();
      const payload: EmailIntegration = {
        provider: 'resend',
        fromName: fromName || fromEmail.split('@')[0] || 'Nursery',
        fromEmail,
        configuredAt: existing?.configuredAt || now,
        configuredByUserId: existing?.configuredByUserId || uid,
        updatedAt: now
      };

      await integrationRef(tenantId).set(payload, { merge: true });
      res.json({
        configured: true,
        platformReady: isResendConfigured(),
        fromEmail: payload.fromEmail,
        fromName: payload.fromName,
        configuredAt: payload.configuredAt
      });
    })
  );

  app.post('/api/email/disconnect', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);
      await integrationRef(tenantId).delete();
      res.json({ ok: true });
    })
  );

  app.post('/api/send-invoice', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const to = String(req.body?.to || '').trim();
      const subject = String(req.body?.subject || '').trim();
      const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
      const html = typeof req.body?.html === 'string' ? req.body.html : undefined;
      const fromNameOverride =
        typeof req.body?.fromName === 'string' ? req.body.fromName.trim() : undefined;

      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      if (!to || !subject || (!text && !html)) {
        res.status(400).json({ error: 'Missing required email fields (to, subject, text/html).' });
        return;
      }
      await assertCanSendInvoice(tenantId, uid);

      try {
        const result = await sendTenantInvoiceEmail({
          tenantId,
          to,
          subject,
          text,
          html,
          fromNameOverride
        });
        res.json({
          success: true,
          messageId: result.messageId,
          fromEmail: result.fromEmail,
          fromName: result.fromName
        });
      } catch (err: any) {
        if (
          err?.code === 'TENANT_SMTP_NOT_CONFIGURED' ||
          err?.code === 'RESEND_NOT_CONFIGURED' ||
          err?.status === 400
        ) {
          res.status(200).json({
            success: false,
            code: err.code || 'TENANT_SMTP_NOT_CONFIGURED',
            message: err.message
          });
          return;
        }
        throw err;
      }
    })
  );

  /** Public: nursery access requests from the marketing / welcome page. */
  app.post('/api/request-access', (req, res) => {
    void (async () => {
      try {
        const displayName = String(req.body?.displayName || '').trim();
        const nurseryName = String(req.body?.nurseryName || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const message = String(req.body?.message || '').trim();
        const locale = String(req.body?.locale || '').trim();

        if (!displayName || displayName.length > 120) {
          res.status(400).json({ error: 'Please enter your name.' });
          return;
        }
        if (!nurseryName || nurseryName.length > 160) {
          res.status(400).json({ error: 'Please enter your nursery name.' });
          return;
        }
        if (!looksLikeEmail(email) || email.length > 200) {
          res.status(400).json({ error: 'Please enter a valid email address.' });
          return;
        }
        if (message.length > 4000) {
          res.status(400).json({ error: 'Message is too long.' });
          return;
        }

        const to =
          process.env.ACCESS_REQUEST_EMAIL?.trim() ||
          process.env.OWNER_EMAIL?.trim() ||
          'owner@nurseryos.app';

        let requestId: string | null = null;
        if (isFirebaseAdminConfigured()) {
          try {
            requestId = await createAccessRequestDoc({
              displayName,
              nurseryName,
              email,
              message,
              locale
            });
          } catch (persistErr) {
            console.error('[email] failed to persist access request', persistErr);
          }
        }

        const text = [
          'New NurseryOS access request',
          '',
          `Name: ${displayName}`,
          `Nursery: ${nurseryName}`,
          `Email: ${email}`,
          locale ? `Language: ${locale}` : null,
          requestId ? `Request ID: ${requestId}` : null,
          '',
          message || '(No additional message)',
          '',
          'Approve in NurseryOS Seller → Access requests.'
        ]
          .filter((line) => line != null)
          .join('\n');

        const html = `
          <h2>New NurseryOS access request</h2>
          <p><strong>Name:</strong> ${escapeHtml(displayName)}</p>
          <p><strong>Nursery:</strong> ${escapeHtml(nurseryName)}</p>
          <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
          ${locale ? `<p><strong>Language:</strong> ${escapeHtml(locale)}</p>` : ''}
          ${requestId ? `<p><strong>Request ID:</strong> ${escapeHtml(requestId)}</p>` : ''}
          <p><strong>Message:</strong></p>
          <p>${escapeHtml(message || '(No additional message)').replace(/\n/g, '<br/>')}</p>
          <p style="margin-top:16px;">Approve in <strong>NurseryOS Seller → Access requests</strong>.</p>
        `;

        const messageId = await sendViaResend({
          fromName: 'NurseryOS',
          replyTo: email,
          to,
          subject: `Access request: ${nurseryName}`,
          text,
          html
        });

        res.json({ success: true, messageId, requestId });
      } catch (err: any) {
        httpError(res, err);
      }
    })();
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
