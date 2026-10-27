import crypto from 'crypto';

/** Standard Webhooks tolerance used by Melio (5 minutes). */
export const MELIO_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type MelioWebhookVerifyInput = {
  rawBody: Buffer;
  webhookId?: string;
  webhookTimestamp?: string;
  webhookSignature?: string;
  legacySignature?: string;
  /** Portal signing secret (`whsec_...`). Used only for the Standard Webhooks check. */
  webhookSecret?: string;
  /** Secret for the older `x-melio-signature` hex HMAC. Never the whsec_ key. */
  legacySecret?: string;
  nowMs?: number;
};

function decodeWebhookKey(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith('whsec_')) return null;
  const encoded = trimmed.slice('whsec_'.length);
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) return null;
  return key;
}

function signaturesMatch(expected: Buffer, encoded: string): boolean {
  const received = Buffer.from(encoded, 'base64');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/** HMAC-SHA256 over `{id}.{timestamp}.{raw body}` with the base64-decoded whsec_ key. */
export function verifyStandardMelioWebhook(
  input: Pick<
    MelioWebhookVerifyInput,
    'rawBody' | 'webhookId' | 'webhookTimestamp' | 'webhookSignature' | 'webhookSecret' | 'nowMs'
  >
): boolean {
  const id = String(input.webhookId || '').trim();
  const timestamp = String(input.webhookTimestamp || '').trim();
  const signatureHeader = String(input.webhookSignature || '').trim();
  const secret = String(input.webhookSecret || '').trim();
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) return false;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - signedAt) > MELIO_WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = decodeWebhookKey(secret);
  if (!key) return false;

  const expected = crypto
    .createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), input.rawBody]))
    .digest();

  return signatureHeader.split(' ').some((entry) => {
    if (!entry.startsWith('v1,')) return false;
    return signaturesMatch(expected, entry.slice(3));
  });
}

/** Older deliveries: hex HMAC-SHA256 of the raw body in `x-melio-signature`. */
export function verifyLegacyMelioSignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  const trimmedSecret = secret.trim();
  const trimmedSignature = signature.trim();
  if (!trimmedSecret || !trimmedSignature) return false;
  const expected = crypto.createHmac('sha256', trimmedSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(trimmedSignature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Accept a Standard Webhooks delivery, or an older `x-melio-signature` delivery.
 * `webhookSecret` is never replaced with the API key. The legacy check uses
 * `legacySecret` only.
 */
export function verifyMelioWebhook(input: MelioWebhookVerifyInput): boolean {
  const hasStandardHeaders = Boolean(
    String(input.webhookId || '').trim() &&
      String(input.webhookTimestamp || '').trim() &&
      String(input.webhookSignature || '').trim()
  );
  if (hasStandardHeaders && verifyStandardMelioWebhook(input)) return true;
  return verifyLegacyMelioSignature(
    input.rawBody,
    String(input.legacySignature || ''),
    String(input.legacySecret || '')
  );
}

/** Legacy HMAC key: a non-whsec webhook secret, otherwise the API key. */
export function legacyMelioWebhookSecret(webhookSecret: string, apiKey: string): string {
  const webhook = webhookSecret.trim();
  const key = apiKey.trim();
  if (webhook && !webhook.startsWith('whsec_')) return webhook;
  return key;
}
