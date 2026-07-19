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

function normalizeServiceAccount(parsed: admin.ServiceAccount & { private_key?: string; client_email?: string }) {
  if (parsed?.private_key && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  const email = parsed.clientEmail || parsed.client_email;
  if (!email || !parsed?.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key.');
  }
  return parsed;
}

function parseJsonCandidate(candidate: string): admin.ServiceAccount {
  return normalizeServiceAccount(JSON.parse(candidate) as admin.ServiceAccount & { private_key?: string });
}

/**
 * Prefer FIREBASE_SERVICE_ACCOUNT_BASE64 on Railway — pasting raw JSON often breaks
 * because of newlines in private_key. Base64 is a single safe line.
 * Also accept raw JSON accidentally pasted into the BASE64 variable.
 */
function parseServiceAccount(): admin.ServiceAccount | null {
  const base64Env = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (base64Env) {
    const cleaned = stripWrappingQuotes(base64Env.replace(/^\uFEFF/, ''));

    // User pasted raw JSON into the BASE64 variable — accept it.
    if (cleaned.startsWith('{')) {
      try {
        return parseJsonCandidate(cleaned);
      } catch (err: any) {
        throw new Error(
          `FIREBASE_SERVICE_ACCOUNT_BASE64 looks like JSON but failed to parse (${err?.message || 'invalid'}). On Railway, multiline JSON often breaks — use base64 instead.`
        );
      }
    }

    const b64 = cleaned.replace(/\s+/g, '');
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
    } catch (err: any) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64 (${err?.message || 'invalid'}).`
      );
    }

    if (!decoded.startsWith('{')) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 decoded to garbage (not JSON). Re-copy with: base64 < ~/Downloads/nurseryos-54c15-firebase-adminsdk-fbsvc-5f9a77ed21.json | tr -d \'\\n\' | pbcopy — then check with: pbpaste | head -c 3  (should print eyJ).'
      );
    }

    try {
      return parseJsonCandidate(decoded);
    } catch (err: any) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_BASE64 decoded but JSON parse failed (${err?.message || 'invalid'}).`
      );
    }
  }

  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!rawEnv) return null;

  const candidates: string[] = [];
  const cleaned = stripWrappingQuotes(rawEnv.replace(/^\uFEFF/, ''));
  candidates.push(cleaned);

  // Whole value stored as a JSON string (extra escaping).
  if (cleaned.includes('\\"') || !cleaned.startsWith('{')) {
    try {
      const unescaped = JSON.parse(cleaned);
      if (typeof unescaped === 'string') candidates.push(unescaped);
      else if (unescaped && typeof unescaped === 'object') {
        return normalizeServiceAccount(unescaped as admin.ServiceAccount & { private_key?: string });
      }
    } catch {
      // keep trying
    }
  }

  // Value might already be base64 sitting in the JSON-named var.
  try {
    const decoded = Buffer.from(cleaned.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) candidates.push(decoded);
  } catch {
    // not base64
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return parseJsonCandidate(candidate);
    } catch (err) {
      lastError = err;
    }
  }

  const hint =
    lastError instanceof Error && lastError.message ? ` (${lastError.message})` : '';
  throw new Error(
    `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON${hint}. Prefer FIREBASE_SERVICE_ACCOUNT_BASE64 on Railway.`
  );
}

export function isFirebaseAdminConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim() ||
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
        'Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64 in Railway (base64 of the service account JSON file).'
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
