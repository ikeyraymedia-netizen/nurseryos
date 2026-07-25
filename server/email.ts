import type { Express, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

interface EmailIntegration {
  provider: 'smtp';
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  configuredAt: string;
  configuredByUserId: string;
  updatedAt: string;
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

export async function sendTenantInvoiceEmail(params: {
  tenantId: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromNameOverride?: string;
}): Promise<{ messageId: string; fromEmail: string; fromName: string }> {
  const integration = await loadIntegration(params.tenantId);
  if (!integration?.smtpPass || !integration.smtpUser || !integration.fromEmail) {
    throw Object.assign(
      new Error(
        'This nursery has not configured outbound email yet. Open Team → Outbound email and add the nursery’s Gmail/Workspace address + App Password.'
      ),
      { status: 400, code: 'TENANT_SMTP_NOT_CONFIGURED' }
    );
  }

  const host = integration.smtpHost || 'smtp.gmail.com';
  const port = Number(integration.smtpPort || 465);
  const fromName = (params.fromNameOverride || integration.fromName || '').trim() || 'Nursery';
  const fromEmail = integration.fromEmail.trim();

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user: integration.smtpUser.trim(),
      pass: integration.smtpPass
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });

  const info = await transporter.sendMail({
    from: `"${fromName.replace(/"/g, '')}" <${fromEmail}>`,
    replyTo: fromEmail,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html
  });

  return {
    messageId: String(info.messageId || ''),
    fromEmail,
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
        configured: Boolean(integration?.smtpPass && integration?.fromEmail),
        fromEmail: integration?.fromEmail || null,
        fromName: integration?.fromName || null,
        smtpHost: integration?.smtpHost || null,
        smtpUser: integration?.smtpUser || null,
        configuredAt: integration?.configuredAt || null
      });
    })
  );

  app.post('/api/email/config', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const fromEmail = String(req.body?.fromEmail || '').trim();
      const fromName = String(req.body?.fromName || '').trim();
      const smtpUser = String(req.body?.smtpUser || fromEmail).trim();
      const smtpPass = String(req.body?.smtpPass || '').trim();
      const smtpHost = String(req.body?.smtpHost || 'smtp.gmail.com').trim() || 'smtp.gmail.com';
      const smtpPort = Number(req.body?.smtpPort || 465) || 465;

      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      if (!looksLikeEmail(fromEmail)) {
        res.status(400).json({ error: 'Enter a valid From email address.' });
        return;
      }
      if (!smtpPass) {
        // Allow updating display fields without re-entering password if already configured
        const existing = await loadIntegration(tenantId);
        if (!existing?.smtpPass) {
          res.status(400).json({ error: 'App Password / SMTP password is required.' });
          return;
        }
      }

      const existing = await loadIntegration(tenantId);
      const now = new Date().toISOString();
      const payload: EmailIntegration = {
        provider: 'smtp',
        fromName: fromName || fromEmail.split('@')[0] || 'Nursery',
        fromEmail,
        smtpHost,
        smtpPort,
        smtpUser: smtpUser || fromEmail,
        smtpPass: smtpPass || existing!.smtpPass,
        configuredAt: existing?.configuredAt || now,
        configuredByUserId: existing?.configuredByUserId || uid,
        updatedAt: now
      };

      await integrationRef(tenantId).set(payload, { merge: true });
      res.json({
        configured: true,
        fromEmail: payload.fromEmail,
        fromName: payload.fromName,
        smtpHost: payload.smtpHost,
        smtpUser: payload.smtpUser,
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
        if (err?.code === 'TENANT_SMTP_NOT_CONFIGURED' || err?.status === 400) {
          res.status(200).json({
            success: false,
            code: 'TENANT_SMTP_NOT_CONFIGURED',
            message: err.message
          });
          return;
        }
        throw err;
      }
    })
  );
}
