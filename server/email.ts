import type { Express, Request, Response } from 'express';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';
import { createAccessRequestDoc } from './platform';

interface EmailIdentity {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
}

interface EmailIntegration {
  /** reply-to / customer-facing nursery contact email (default identity) */
  fromName: string;
  fromEmail: string;
  identities?: EmailIdentity[];
  defaultIdentityId?: string;
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

const MAX_CC_RECIPIENTS = 20;

function splitEmailList(value: unknown): string[] {
  const rawParts = Array.isArray(value)
    ? value.flatMap((entry) => String(entry || '').split(/[,;\n\r]+/))
    : String(value || '').split(/[,;\n\r]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawParts) {
    const email = extractEmailAddress(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Accept bare emails or "Name <email@x.com>" / "<email@x.com>". */
function extractEmailAddress(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const angle = trimmed.match(/<([^>]+)>/);
  const candidate = (angle?.[1] || trimmed).trim().toLowerCase();
  return looksLikeEmail(candidate) ? candidate : '';
}

function parseCcRecipients(value: unknown, to: string): string[] {
  const toNorm = String(to || '').trim().toLowerCase();
  const cc = splitEmailList(value).filter((email) => email !== toNorm);
  if (!cc.length) return [];
  const invalid = cc.filter((email) => !looksLikeEmail(email));
  if (invalid.length) {
    throw Object.assign(
      new Error(`These CC addresses are not valid: ${invalid.join(', ')}`),
      { status: 400 }
    );
  }
  if (cc.length > MAX_CC_RECIPIENTS) {
    throw Object.assign(
      new Error(`You can CC at most ${MAX_CC_RECIPIENTS} addresses.`),
      { status: 400 }
    );
  }
  return cc;
}

function newIdentityId(): string {
  return `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeIdentity(raw: any): EmailIdentity | null {
  const fromEmail = String(raw?.fromEmail || '').trim().toLowerCase();
  if (!looksLikeEmail(fromEmail)) return null;
  const fromName = String(raw?.fromName || '').trim() || fromEmail.split('@')[0] || 'Nursery';
  const label = String(raw?.label || '').trim() || fromName;
  const id = String(raw?.id || '').trim() || newIdentityId();
  return { id, label: label.slice(0, 80), fromName: fromName.slice(0, 120), fromEmail };
}

function identitiesFromDoc(doc: EmailIntegration | null): EmailIdentity[] {
  if (!doc) return [];
  const fromList = Array.isArray(doc.identities)
    ? doc.identities.map(sanitizeIdentity).filter((row): row is EmailIdentity => Boolean(row))
    : [];
  if (fromList.length) {
    const seen = new Set<string>();
    return fromList.filter((row) => {
      if (seen.has(row.fromEmail)) return false;
      seen.add(row.fromEmail);
      return true;
    });
  }
  if (doc.fromEmail && looksLikeEmail(doc.fromEmail)) {
    return [
      {
        id: 'primary',
        label: doc.fromName || 'Default',
        fromName: doc.fromName || doc.fromEmail.split('@')[0] || 'Nursery',
        fromEmail: doc.fromEmail.trim().toLowerCase()
      }
    ];
  }
  return [];
}

function pickIdentity(
  identities: EmailIdentity[],
  defaultId: string | undefined,
  requestedEmail?: string
): EmailIdentity | null {
  if (!identities.length) return null;
  const requested = String(requestedEmail || '').trim().toLowerCase();
  if (requested) {
    const match = identities.find((row) => row.fromEmail === requested);
    if (match) return match;
  }
  return identities.find((row) => row.id === defaultId) || identities[0];
}

function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function platformFromAddress(): string {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  // Resend test sender works immediately; replace with a verified domain in production.
  return configured || 'NurseryOS <onboarding@resend.dev>';
}

const MAX_PDF_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function parsePdfAttachment(raw: unknown): { filename: string; content: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const filenameRaw = String((raw as { filename?: unknown }).filename || '').trim();
  let content = String((raw as { content?: unknown }).content || '').replace(/\s/g, '');
  const dataUrl = content.match(/^data:application\/pdf;base64,(.+)$/i);
  if (dataUrl) content = dataUrl[1];
  if (!content) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
    throw Object.assign(new Error('PDF attachment is not valid base64.'), { status: 400 });
  }
  const bytes = Math.floor((content.length * 3) / 4);
  if (bytes > MAX_PDF_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('PDF attachment is too large to email.'), { status: 400 });
  }
  const safeName =
    filenameRaw.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'document.pdf';
  const filename = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  return { filename, content };
}

async function sendViaResend(params: {
  fromName: string;
  replyTo: string;
  to: string;
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string }>;
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
  const usingTestSender = /resend\.dev$/i.test(fromAddress);

  // Include CC on `to` so Resend actually delivers to them. The standalone `cc`
  // field is unreliable on some Resend from-domains (notably onboarding@resend.dev).
  const toRecipients = [params.to, ...(params.cc || [])].filter(
    (email, index, all) => looksLikeEmail(email) && all.indexOf(email) === index
  );

  if (usingTestSender && (params.cc?.length || 0) > 0) {
    console.warn(
      '[email] Sending with Resend test sender; CC recipients were added to `to` for delivery. Set RESEND_FROM_EMAIL to a verified domain.'
    );
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromHeader,
      to: toRecipients,
      reply_to: [params.replyTo],
      subject: params.subject,
      text: params.text,
      html: params.html,
      ...(params.attachments?.length
        ? {
            attachments: params.attachments.map((file) => ({
              filename: file.filename,
              content: file.content,
              content_type: 'application/pdf'
            }))
          }
        : {})
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
  cc?: string[] | string;
  subject: string;
  text?: string;
  html?: string;
  fromNameOverride?: string;
  fromEmailOverride?: string;
  pdfAttachment?: { filename?: string; content?: string };
}): Promise<{ messageId: string; fromEmail: string; fromName: string; cc: string[] }> {
  const integration = await loadIntegration(params.tenantId);
  const identities = identitiesFromDoc(integration);
  if (!identities.length) {
    throw Object.assign(
      new Error(
        'This nursery has not configured outbound email yet. Open Team → Outbound email and add the nursery’s reply-to address.'
      ),
      { status: 400, code: 'TENANT_SMTP_NOT_CONFIGURED' }
    );
  }

  const requested = String(params.fromEmailOverride || '').trim().toLowerCase();
  if (requested && !identities.some((row) => row.fromEmail === requested)) {
    throw Object.assign(
      new Error('That reply-to address is not in this nursery’s outbound email list.'),
      { status: 400 }
    );
  }

  const chosen = pickIdentity(identities, integration?.defaultIdentityId, requested);
  if (!chosen) {
    throw Object.assign(
      new Error(
        'This nursery has not configured outbound email yet. Open Team → Outbound email and add the nursery’s reply-to address.'
      ),
      { status: 400, code: 'TENANT_SMTP_NOT_CONFIGURED' }
    );
  }

  const fromName =
    (params.fromNameOverride || chosen.fromName || integration?.fromName || '').trim() || 'Nursery';
  const replyTo = chosen.fromEmail;
  const to = String(params.to || '').trim().toLowerCase();
  if (!looksLikeEmail(to)) {
    throw Object.assign(new Error('Enter a valid To email address.'), { status: 400 });
  }
  const cc = parseCcRecipients(params.cc, to);
  const pdfAttachment = parsePdfAttachment(params.pdfAttachment);

  const messageId = await sendViaResend({
    fromName,
    replyTo,
    to,
    cc,
    subject: params.subject,
    text: params.text,
    html: params.html,
    attachments: pdfAttachment ? [pdfAttachment] : undefined
  });

  return {
    messageId,
    fromEmail: replyTo,
    fromName,
    cc
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
      const identities = identitiesFromDoc(integration);
      const defaultId = integration?.defaultIdentityId;
      const primary = pickIdentity(identities, defaultId);
      res.json({
        configured: identities.length > 0,
        platformReady: isResendConfigured(),
        fromEmail: primary?.fromEmail || integration?.fromEmail || null,
        fromName: primary?.fromName || integration?.fromName || null,
        identities,
        defaultIdentityId: primary?.id || null,
        configuredAt: integration?.configuredAt || null
      });
    })
  );

  app.post('/api/email/config', (req, res) =>
    withAuth(req, res, async (uid) => {
      const tenantId = String(req.body?.tenantId || '');
      const fromEmail = String(req.body?.fromEmail || '').trim();
      const fromName = String(req.body?.fromName || '').trim();
      const requestedIdentities = Array.isArray(req.body?.identities) ? req.body.identities : null;
      const requestedDefaultId =
        typeof req.body?.defaultIdentityId === 'string' ? req.body.defaultIdentityId.trim() : '';

      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }
      await assertAdminOrOwner(tenantId, uid);

      let identities: EmailIdentity[] = [];
      if (requestedIdentities) {
        identities = requestedIdentities
          .map(sanitizeIdentity)
          .filter((row): row is EmailIdentity => Boolean(row));
      } else if (looksLikeEmail(fromEmail)) {
        identities = [
          {
            id: 'primary',
            label: fromName || 'Default',
            fromName: fromName || fromEmail.split('@')[0] || 'Nursery',
            fromEmail: fromEmail.toLowerCase()
          }
        ];
      }

      if (!identities.length) {
        res.status(400).json({ error: 'Enter at least one valid reply-to email address.' });
        return;
      }

      const existing = await loadIntegration(tenantId);
      const now = new Date().toISOString();
      const primary =
        identities.find((row) => row.id === requestedDefaultId) || identities[0];
      const payload: EmailIntegration = {
        provider: 'resend',
        fromName: primary.fromName,
        fromEmail: primary.fromEmail,
        identities,
        defaultIdentityId: primary.id,
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
        identities,
        defaultIdentityId: payload.defaultIdentityId,
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
      const cc = req.body?.cc;
      const subject = String(req.body?.subject || '').trim();
      const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
      const html = typeof req.body?.html === 'string' ? req.body.html : undefined;
      const fromNameOverride =
        typeof req.body?.fromName === 'string' ? req.body.fromName.trim() : undefined;
      const fromEmailOverride =
        typeof req.body?.fromEmail === 'string' ? req.body.fromEmail.trim() : undefined;
      const pdfAttachment = req.body?.pdfAttachment;

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
          cc,
          subject,
          text,
          html,
          fromNameOverride,
          fromEmailOverride,
          pdfAttachment
        });
        res.json({
          success: true,
          messageId: result.messageId,
          fromEmail: result.fromEmail,
          fromName: result.fromName,
          cc: result.cc
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
