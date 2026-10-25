import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { getAdminDb } from './firebaseAdmin';

type Authed = { uid: string; email: string };

function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function originOf(req: Request): string {
  const header = String(req.headers.origin || '').trim();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(header)) return header;
  const fromEnv = process.env.APP_URL?.trim() || process.env.PUBLIC_APP_URL?.trim();
  if (fromEnv) return new URL(fromEnv).origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'nurseryos.app').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

function rpIdOf(req: Request): string {
  return new URL(originOf(req)).hostname;
}

async function saveChallenge(uid: string, challenge: string) {
  await getAdminDb().doc(`users/${uid}`).set(
    { passkeyChallenge: challenge, passkeyChallengeExp: Date.now() + 5 * 60 * 1000 },
    { merge: true }
  );
}

async function takeChallenge(uid: string): Promise<string> {
  const ref = getAdminDb().doc(`users/${uid}`);
  const snap = await ref.get();
  const challenge = String(snap.data()?.passkeyChallenge || '');
  const exp = Number(snap.data()?.passkeyChallengeExp || 0);
  await ref.set({ passkeyChallenge: null, passkeyChallengeExp: null }, { merge: true });
  if (!challenge || exp < Date.now()) throw httpError(400, 'That passkey check expired. Try again.', 'passkey');
  return challenge;
}

export function registerPasskeyRoutes(
  app: Express,
  requireUser: (req: Request) => Promise<Authed>,
  sendErr: (res: Response, err: unknown) => void
): void {
  app.get('/api/security/passkey/status', async (req, res) => {
    try {
      const user = await requireUser(req);
      const snap = await getAdminDb().collection(`users/${user.uid}/passkeys`).limit(10).get();
      res.json({ count: snap.size });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/passkey/options', async (req, res) => {
    try {
      const user = await requireUser(req);
      const challenge = b64url(crypto.randomBytes(32));
      await saveChallenge(user.uid, challenge);
      res.json({
        challenge,
        rp: { name: 'NurseryOS', id: rpIdOf(req) },
        user: {
          id: b64url(Buffer.from(user.uid)),
          name: user.email || user.uid,
          displayName: user.email || 'NurseryOS'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        timeout: 60000,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        attestation: 'none'
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/passkey/register', async (req, res) => {
    try {
      const user = await requireUser(req);
      await takeChallenge(user.uid);
      const id = String(req.body?.id || '').trim();
      const publicKey = String(req.body?.publicKey || '').trim();
      const algorithm = Number(req.body?.algorithm);
      if (!id || id.length > 300 || !publicKey || publicKey.length > 4000) {
        throw httpError(400, 'This device did not share a passkey.', 'passkey');
      }
      if (algorithm !== -7 && algorithm !== -257) {
        throw httpError(400, 'This passkey uses an unsupported key type.', 'passkey');
      }
      crypto.createPublicKey({ key: fromB64url(publicKey), format: 'der', type: 'spki' });
      await getAdminDb().doc(`users/${user.uid}/passkeys/${id}`).set({
        credentialId: id,
        publicKey,
        algorithm,
        counter: 0,
        createdAt: Date.now()
      });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/passkey/auth-options', async (req, res) => {
    try {
      const user = await requireUser(req);
      const snap = await getAdminDb().collection(`users/${user.uid}/passkeys`).limit(10).get();
      if (snap.empty) throw httpError(400, 'No passkey is set up for this login.', 'passkey');
      const challenge = b64url(crypto.randomBytes(32));
      await saveChallenge(user.uid, challenge);
      res.json({
        challenge,
        rpId: rpIdOf(req),
        timeout: 60000,
        allowCredentials: snap.docs.map((doc) => ({
          id: doc.id,
          type: 'public-key'
        }))
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  app.post('/api/security/passkey/auth', async (req, res) => {
    try {
      const user = await requireUser(req);
      const expected = await takeChallenge(user.uid);
      const id = String(req.body?.id || '').trim();
      const clientDataJSON = fromB64url(String(req.body?.clientDataJSON || ''));
      const authenticatorData = fromB64url(String(req.body?.authenticatorData || ''));
      const signature = fromB64url(String(req.body?.signature || ''));
      const snap = await getAdminDb().doc(`users/${user.uid}/passkeys/${id}`).get();
      if (!snap.exists) throw httpError(400, 'That passkey is not on this login.', 'passkey');
      const stored = snap.data() || {};
      const clientData = JSON.parse(clientDataJSON.toString('utf8')) as {
        type?: string;
        challenge?: string;
        origin?: string;
      };
      if (clientData.type !== 'webauthn.get' || clientData.challenge !== expected) {
        throw httpError(400, 'That passkey check did not match. Try again.', 'passkey');
      }
      if (clientData.origin !== originOf(req)) {
        throw httpError(400, 'That passkey check did not match. Try again.', 'passkey');
      }
      if (authenticatorData.length < 37) throw httpError(400, 'That passkey check did not match. Try again.', 'passkey');
      const rpHash = crypto.createHash('sha256').update(rpIdOf(req)).digest();
      if (!rpHash.equals(authenticatorData.subarray(0, 32))) {
        throw httpError(400, 'That passkey check did not match. Try again.', 'passkey');
      }
      const flags = authenticatorData[32];
      if ((flags & 0x01) === 0) throw httpError(400, 'Confirm the passkey on this device.', 'passkey');
      const counter = authenticatorData.readUInt32BE(33);
      const previous = Number(stored.counter || 0);
      if (counter !== 0 && counter <= previous) {
        throw httpError(400, 'That passkey was already used. Try again.', 'passkey');
      }
      const key = crypto.createPublicKey({
        key: fromB64url(String(stored.publicKey || '')),
        format: 'der',
        type: 'spki'
      });
      const clientHash = crypto.createHash('sha256').update(clientDataJSON).digest();
      const signed = Buffer.concat([authenticatorData, clientHash]);
      const algorithm = Number(stored.algorithm);
      const ok =
        algorithm === -257
          ? crypto.verify('RSA-SHA256', signed, key, signature)
          : crypto.verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
      if (!ok) throw httpError(400, 'That passkey check did not match. Try again.', 'passkey');
      await snap.ref.set({ counter: Math.max(counter, previous) }, { merge: true });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });
}
