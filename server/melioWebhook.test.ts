import assert from 'node:assert/strict';
import crypto from 'crypto';
import test from 'node:test';
import { verifyMelioWebhook } from './melioWebhook.ts';

const key = Buffer.from('test-melio-webhook-key-32-bytes!!');
const webhookSecret = `whsec_${key.toString('base64')}`;
const body = Buffer.from(
  JSON.stringify({ event: 'api.payment.updated', id: 'pay_123', entityId: 'ent_1' })
);
const webhookId = 'msg_test_1';

function sign(rawBody: Buffer, id: string, timestamp: string, hmacKey: Buffer = key): string {
  const mac = crypto
    .createHmac('sha256', hmacKey)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]))
    .digest('base64');
  return `v1,${mac}`;
}

test('accepts a valid Standard Webhooks signature', () => {
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  const ok = verifyMelioWebhook({
    rawBody: body,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: `v1,${Buffer.from('nope').toString('base64')} ${sign(body, webhookId, timestamp)}`,
    webhookSecret,
    legacySecret: 'api-key-must-not-be-required',
    nowMs
  });
  assert.equal(ok, true);
});

test('rejects a wrong signature', () => {
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  const otherKey = Buffer.from('different-key-not-the-webhook!!');
  const ok = verifyMelioWebhook({
    rawBody: body,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: sign(body, webhookId, timestamp, otherKey),
    webhookSecret,
    legacySecret: otherKey.toString('utf8'),
    nowMs
  });
  assert.equal(ok, false);
});

test('rejects a timestamp more than 5 minutes off', () => {
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000) - 301);
  const ok = verifyMelioWebhook({
    rawBody: body,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: sign(body, webhookId, timestamp),
    webhookSecret,
    nowMs
  });
  assert.equal(ok, false);
});

test('still accepts the legacy x-melio-signature hex HMAC', () => {
  const legacySecret = 'older-delivery-secret';
  const legacySignature = crypto.createHmac('sha256', legacySecret).update(body).digest('hex');
  const ok = verifyMelioWebhook({
    rawBody: body,
    legacySignature,
    webhookSecret,
    legacySecret
  });
  assert.equal(ok, true);
});
