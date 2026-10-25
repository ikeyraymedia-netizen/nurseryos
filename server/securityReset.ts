import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getAdminDb } from './firebaseAdmin';
import { RESET_LINK_TTL_MS, sha256Hex } from '../src/lib/securityPolicy';

export const GENERIC_RESET_MESSAGE =
  'If an account exists for that email, a reset link is on its way. It expires in 15 minutes and works once.';

export async function resetTokenDocId(rawToken: string): Promise<string> {
  return (await sha256Hex(rawToken)).toLowerCase();
}

/** Issue a single-use NurseryOS reset link. The raw token is not stored. */
export async function createStrictPasswordResetLink(
  email: string,
  appUrl: string
): Promise<{ url: string; uid: string; tokenId: string }> {
  getAdminDb();
  const normalized = email.trim().toLowerCase();
  const user = await admin.auth().getUserByEmail(normalized);
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenId = await resetTokenDocId(rawToken);
  const now = Date.now();
  await getAdminDb().doc(`securityResetTokens/${tokenId}`).set({
    uid: user.uid,
    email: normalized,
    expiresAt: now + RESET_LINK_TTL_MS,
    usedAt: null,
    createdAt: now,
    purpose: 'password'
  });
  const base = appUrl.replace(/\/$/, '');
  return { url: `${base}/?melioReset=${encodeURIComponent(rawToken)}`, uid: user.uid, tokenId };
}
