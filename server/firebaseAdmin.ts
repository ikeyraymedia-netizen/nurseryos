import admin from 'firebase-admin';
import { getFirestore, Firestore, DocumentData } from 'firebase-admin/firestore';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'nurseryos-54c15';
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

let db: Firestore | null = null;

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Railway/env pastes often mangle service-account JSON. Accept:
 * - raw JSON (pretty or single-line)
 * - JSON wrapped in extra quotes
 * - base64-encoded JSON
 * - private_key newlines stored as literal \n (standard in env vars)
 */
function parseServiceAccount(): admin.ServiceAccount | null {
  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!rawEnv) return null;

  const candidates: string[] = [];
  const cleaned = stripWrappingQuotes(rawEnv.replace(/^\uFEFF/, ''));
  candidates.push(cleaned);

  // Sometimes the whole JSON is escaped once more as a JSON string.
  if (cleaned.includes('\\"') || cleaned.startsWith('{') === false) {
    try {
      const unescaped = JSON.parse(cleaned);
      if (typeof unescaped === 'string') candidates.push(unescaped);
      else if (unescaped && typeof unescaped === 'object') {
        return unescaped as admin.ServiceAccount;
      }
    } catch {
      // keep trying other formats
    }
  }

  // Base64 of the JSON file (recommended for Railway).
  try {
    const decoded = Buffer.from(cleaned, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) candidates.push(decoded);
  } catch {
    // not base64
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as admin.ServiceAccount & {
        private_key?: string;
      };
      if (parsed?.private_key && parsed.private_key.includes('\\n')) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      if (!parsed || (typeof parsed === 'object' && !('client_email' in parsed) && !('private_key' in parsed))) {
        throw new Error('Parsed JSON is missing service account fields.');
      }
      return parsed;
    } catch (err) {
      lastError = err;
    }
  }

  const hint =
    lastError instanceof Error && lastError.message
      ? ` (${lastError.message})`
      : '';
  throw new Error(
    `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON${hint}. In Railway, paste the raw JSON file contents, or set the value to base64 of that file (no extra quotes).`
  );
}

export function isFirebaseAdminConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  );
}

export function getAdminDb(): Firestore {
  if (db) return db;

  if (!admin.apps.length) {
    const serviceAccount = parseServiceAccount();
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.projectId || PROJECT_ID
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ projectId: PROJECT_ID });
    } else {
      throw new Error(
        'Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (service account JSON) in Railway.'
      );
    }
  }

  db = getFirestore(admin.app(), DATABASE_ID);
  return db;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  getAdminDb();
  return admin.auth().verifyIdToken(idToken);
}

export type MemberRoleName =
  | 'owner'
  | 'admin'
  | 'supervisor'
  | 'office'
  | 'loader'
  | 'inventory'
  | 'field';

export function normalizeRoles(data: DocumentData | undefined): MemberRoleName[] {
  if (!data) return [];
  const raw: string[] = Array.isArray(data.roles) && data.roles.length
    ? data.roles.map(String)
    : data.role
      ? [String(data.role)]
      : [];
  const out: MemberRoleName[] = [];
  for (const role of raw) {
    const canonical = (role === 'field' ? 'inventory' : role) as MemberRoleName;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export async function getMemberRoles(
  tenantId: string,
  userId: string
): Promise<MemberRoleName[]> {
  const snap = await getAdminDb().doc(`tenants/${tenantId}/members/${userId}`).get();
  if (!snap.exists) return [];
  return normalizeRoles(snap.data());
}

export function hasAnyRole(roles: MemberRoleName[], allowed: MemberRoleName[]): boolean {
  return roles.some((r) => allowed.includes(r));
}
