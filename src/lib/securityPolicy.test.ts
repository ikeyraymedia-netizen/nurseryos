import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountRequiresMfa,
  assessPassword,
  botChallengeStatus,
  decideLockout,
  hibpSuffixIsBreached,
  IDLE_TIMEOUT_MS,
  LOCKOUT_DURATION_MS,
  LOCKOUT_MAX_FAILURES,
  MAX_SESSION_MS,
  MFA_RECHECK_MS,
  mfaIsFresh,
  mfaSkipAllowed,
  mfaStepUpRequired,
  parseMelioSecurityStrict,
  PASSWORD_MIN_LENGTH,
  passwordLengthFailure,
  rateLimitAllows,
  RESET_LINK_TTL_MS,
  resetTokenStatus,
  sanitizeAuditDetails,
  sessionFreshness,
  sha1Hex,
  suspiciousPattern
} from './securityPolicy.ts';

const NOW = Date.parse('2026-10-22T18:00:00.000Z');

describe('MELIO_SECURITY_STRICT flag', () => {
  it('defaults off for unset and negative values', () => {
    assert.equal(parseMelioSecurityStrict(undefined), false);
    assert.equal(parseMelioSecurityStrict(null), false);
    assert.equal(parseMelioSecurityStrict(''), false);
    assert.equal(parseMelioSecurityStrict('false'), false);
    assert.equal(parseMelioSecurityStrict('0'), false);
    assert.equal(parseMelioSecurityStrict('no'), false);
    assert.equal(parseMelioSecurityStrict('off'), false);
  });

  it('turns on only for explicit values', () => {
    assert.equal(parseMelioSecurityStrict('true'), true);
    assert.equal(parseMelioSecurityStrict(' TRUE '), true);
    assert.equal(parseMelioSecurityStrict('1'), true);
    assert.equal(parseMelioSecurityStrict('yes'), true);
    assert.equal(parseMelioSecurityStrict('on'), true);
  });
});

describe('password policy', () => {
  it('rejects fewer than 12 characters and allows 64 or more', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
    assert.equal(passwordLengthFailure('short-pass'), 'too_short');
    assert.equal(passwordLengthFailure('x'.repeat(11)), 'too_short');
    assert.equal(passwordLengthFailure('x'.repeat(12)), null);
    assert.equal(passwordLengthFailure('correct horse battery staple and then some more words'), null);
    assert.equal(passwordLengthFailure('p'.repeat(64)), null);
    assert.equal(passwordLengthFailure('p'.repeat(256)), null);
    assert.equal(passwordLengthFailure('p'.repeat(257)), 'too_long');
  });

  it('rejects common passwords before calling the breach API', async () => {
    let lookups = 0;
    const result = await assessPassword('password1234', async () => {
      lookups += 1;
      return '';
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'common');
    assert.equal(lookups, 0);
  });

  it('rejects breached passwords using only the hash prefix', async () => {
    const password = 'nursery-passphrase-gamma-91';
    const hash = await sha1Hex(password);
    let seenPrefix = '';
    const result = await assessPassword(password, async (prefix) => {
      seenPrefix = prefix;
      return `${hash.slice(5)}:42\nDEADBEEF:1\n`;
    });
    assert.equal(seenPrefix, hash.slice(0, 5));
    assert.equal(seenPrefix.length, 5);
    assert.deepEqual(result, { ok: false, reason: 'breached' });
  });

  it('accepts a long passphrase that is not common or breached', async () => {
    const password = 'river-oak-magnolia-wagon-lantern-harvest-74';
    assert.ok(password.length >= 64 || password.length >= 12);
    const result = await assessPassword(password, async () => 'AAAAAA:3\n');
    assert.deepEqual(result, { ok: true, reason: null });
  });

  it('fails closed when the breach list cannot be checked', async () => {
    const result = await assessPassword('river-oak-magnolia-wagon-lantern', async () => null);
    assert.equal(result.reason, 'breach_check_unavailable');
    const thrown = await assessPassword('river-oak-magnolia-wagon-lantern', async () => {
      throw new Error('network');
    });
    assert.equal(thrown.reason, 'breach_check_unavailable');
  });

  it('ignores HIBP padding rows with a zero count', () => {
    const hash = `ABCDE${'F'.repeat(35)}`;
    const suffix = 'F'.repeat(35);
    assert.equal(hibpSuffixIsBreached(hash, `${suffix}:0`), false);
    assert.equal(hibpSuffixIsBreached(hash, `${suffix}:2`), true);
  });
});

describe('login lockout', () => {
  it('locks after 5 failures in the window and holds the lock', () => {
    const stamps = [1, 2, 3, 4].map((n) => NOW - n * 1000);
    const open = decideLockout({ failureTimestamps: stamps, now: NOW, lockedUntil: null });
    assert.equal(open.locked, false);
    assert.equal(open.failuresInWindow, 4);

    const fifth = decideLockout({
      failureTimestamps: [...stamps, NOW],
      now: NOW,
      lockedUntil: null
    });
    assert.equal(fifth.locked, true);
    assert.equal(fifth.lockedUntil, NOW + LOCKOUT_DURATION_MS);
    assert.equal(LOCKOUT_MAX_FAILURES, 5);

    const held = decideLockout({
      failureTimestamps: [],
      now: NOW + 1000,
      lockedUntil: fifth.lockedUntil
    });
    assert.equal(held.locked, true);

    const expired = decideLockout({
      failureTimestamps: [],
      now: (fifth.lockedUntil || 0) + 1,
      lockedUntil: fifth.lockedUntil
    });
    assert.equal(expired.locked, false);
  });
});

describe('sessions', () => {
  it('times out after 1 idle hour and at the 12-hour maximum', () => {
    assert.equal(
      sessionFreshness({ createdAt: NOW, lastActivityAt: NOW, now: NOW + IDLE_TIMEOUT_MS - 1 }),
      'ok'
    );
    assert.equal(
      sessionFreshness({ createdAt: NOW, lastActivityAt: NOW, now: NOW + IDLE_TIMEOUT_MS }),
      'idle'
    );
    assert.equal(
      sessionFreshness({
        createdAt: NOW,
        lastActivityAt: NOW + MAX_SESSION_MS - 1,
        now: NOW + MAX_SESSION_MS
      }),
      'max'
    );
  });
});

describe('MFA requirement', () => {
  it('requires MFA for every signed-in user when the flag is off', () => {
    assert.equal(accountRequiresMfa({ strict: false, signedIn: true, isOwnerOrAdmin: true }), true);
    assert.equal(accountRequiresMfa({ strict: false, signedIn: true, isOwnerOrAdmin: false }), true);
    assert.equal(accountRequiresMfa({ strict: false, signedIn: false, isOwnerOrAdmin: true }), false);
    assert.equal(mfaSkipAllowed(false), true);
    assert.equal(
      mfaStepUpRequired({
        strict: false,
        totpEnrolled: true,
        deviceKnown: false,
        lastMfaAt: null,
        now: NOW
      }),
      false
    );
  });

  it('requires MFA for every signed-in user when the flag is on', () => {
    assert.equal(accountRequiresMfa({ strict: true, signedIn: true, isOwnerOrAdmin: false }), true);
    assert.equal(accountRequiresMfa({ strict: true, signedIn: false, isOwnerOrAdmin: false }), false);
    assert.equal(mfaSkipAllowed(true), false);
  });

  it('asks again on a new device and every 30 days', () => {
    assert.equal(
      mfaStepUpRequired({
        strict: true,
        totpEnrolled: true,
        deviceKnown: false,
        lastMfaAt: NOW,
        now: NOW
      }),
      true
    );
    assert.equal(
      mfaStepUpRequired({
        strict: true,
        totpEnrolled: true,
        deviceKnown: true,
        lastMfaAt: NOW - MFA_RECHECK_MS + 1,
        now: NOW
      }),
      false
    );
    assert.equal(
      mfaStepUpRequired({
        strict: true,
        totpEnrolled: true,
        deviceKnown: true,
        lastMfaAt: NOW - MFA_RECHECK_MS,
        now: NOW
      }),
      true
    );
    assert.equal(mfaIsFresh(NOW - 60_000, NOW), true);
    assert.equal(mfaIsFresh(NOW - 11 * 60 * 1000, NOW), false);
  });
});

describe('reset links', () => {
  it('are single-use and short-lived', () => {
    assert.equal(RESET_LINK_TTL_MS, 15 * 60 * 1000);
    const fresh = { expiresAt: NOW + RESET_LINK_TTL_MS, usedAt: null };
    assert.equal(resetTokenStatus(fresh, NOW), 'ok');
    assert.equal(resetTokenStatus({ ...fresh, usedAt: NOW }, NOW), 'used');
    assert.equal(resetTokenStatus({ expiresAt: NOW, usedAt: null }, NOW), 'expired');
    assert.equal(resetTokenStatus(null, NOW), 'missing');
  });
});

describe('bot checks and audit redaction', () => {
  it('rejects filled honeypots, instant submits, and reused challenges', () => {
    assert.equal(
      botChallengeStatus({ honeypot: '', createdAt: NOW - 2000, now: NOW, used: false }),
      'ok'
    );
    assert.equal(
      botChallengeStatus({ honeypot: 'acme', createdAt: NOW - 2000, now: NOW, used: false }),
      'bot'
    );
    assert.equal(
      botChallengeStatus({ honeypot: '', createdAt: NOW - 500, now: NOW, used: false }),
      'too_fast'
    );
    assert.equal(
      botChallengeStatus({ honeypot: '', createdAt: NOW - 2000, now: NOW, used: true }),
      'used'
    );
  });

  it('throttles repeated auth attempts', () => {
    const hits = Array.from({ length: 20 }, (_, index) => NOW - index * 1000);
    assert.equal(rateLimitAllows({ hits, now: NOW }).allowed, false);
    assert.equal(rateLimitAllows({ hits: hits.slice(0, 19), now: NOW }).allowed, true);
  });

  it('never keeps passwords, codes, or reset tokens in audit details', () => {
    const clean = sanitizeAuditDetails({
      email: 'owner@nursery.example',
      outcome: 'failure',
      password: 'hunter2hunter2',
      mfaCode: '123456',
      resetToken: 'secret-token',
      cookie: 'sid'
    });
    assert.deepEqual(clean, { email: 'owner@nursery.example', outcome: 'failure' });
  });

  it('flags suspicious failure and shared-account patterns', () => {
    assert.equal(suspiciousPattern({ failuresInWindow: 5, mfaFailuresInWindow: 0, newDevicesInWindow: 1 }), 'password_failures');
    assert.equal(suspiciousPattern({ failuresInWindow: 1, mfaFailuresInWindow: 5, newDevicesInWindow: 1 }), 'mfa_failures');
    assert.equal(suspiciousPattern({ failuresInWindow: 0, mfaFailuresInWindow: 0, newDevicesInWindow: 4 }), 'possible_shared_account');
    assert.equal(suspiciousPattern({ failuresInWindow: 1, mfaFailuresInWindow: 1, newDevicesInWindow: 1 }), null);
  });
});
