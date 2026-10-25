import { parseMelioSecurityStrict } from '../src/lib/securityPolicy';

/**
 * MELIO_SECURITY_STRICT
 * Default off (unset, empty, "false", and "0" are all off). Do not enable this
 * in Railway or local .env until the nursery explicitly wants the Melio rules.
 *
 * Passwords stay in Firebase Authentication, which stores them as salted scrypt
 * hashes. This flag does not add a second password database.
 *
 * Sessions: the app already sends Firebase ID tokens as Authorization: Bearer,
 * kept by the Firebase client SDK (IndexedDB), not as server cookies. When this
 * flag is on we do not replace that with a parallel cookie login — that would
 * fight Firebase MFA. Instead the server issues an opaque session id, stores it
 * in an HttpOnly + SameSite=Lax cookie (Secure on HTTPS), and enforces a
 * 1-hour idle timeout, a 12-hour maximum, and revocation. The Firebase ID
 * token remains the credential; the cookie is the revocable session beside it.
 * On plain HTTP (local dev) Secure is omitted so the cookie can be stored.
 */
export function isMelioSecurityStrict(): boolean {
  return parseMelioSecurityStrict(process.env.MELIO_SECURITY_STRICT);
}
