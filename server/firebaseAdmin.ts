import admin from 'firebase-admin';
import { getFirestore, Firestore, DocumentData } from 'firebase-admin/firestore';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'nurseryos-54c15';
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

let db: Firestore | null = null;

function parseServiceAccount(): admin.ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as admin.ServiceAccount;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
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
