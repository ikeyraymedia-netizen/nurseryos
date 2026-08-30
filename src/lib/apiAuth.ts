import { auth } from '../firebase';

/** JSON + Firebase ID token for authenticated API calls. */
export async function authJsonHeaders(extra?: Record<string, string>): Promise<HeadersInit> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(extra || {})
  };
}
