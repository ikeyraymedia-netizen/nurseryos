import {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  User
} from 'firebase/auth';
import { auth, db } from '../firebase';
import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import { Tenant, TenantMember, UserProfile, TenantInvite, MemberRole, TenantModuleId } from '../types';
import {
  DEFAULT_NEW_TENANT_MODULES,
  normalizeModulesList
} from './modules';

function slugifyNurseryName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'nursery'}-${suffix}`;
}

export function watchAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  return snap.data() as UserProfile;
}

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const snap = await getDoc(doc(db, 'tenants', tenantId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<Tenant, 'id'>) };
}

export async function getTenantMembership(
  tenantId: string,
  userId: string
): Promise<TenantMember | null> {
  const snap = await getDoc(doc(db, 'tenants', tenantId, 'members', userId));
  if (!snap.exists()) return null;
  return snap.data() as TenantMember;
}

export async function listUserTenants(uid: string): Promise<Tenant[]> {
  // Membership-first lookup: collect tenants where this user is a member.
  // For v1 each user typically owns/belongs to one nursery.
  const profile = await getUserProfile(uid);
  if (!profile?.activeTenantId) return [];

  const tenant = await getTenant(profile.activeTenantId);
  return tenant ? [tenant] : [];
}

export async function signUpWithNursery(params: {
  email: string;
  password: string;
  displayName: string;
  nurseryName: string;
}): Promise<{ user: User; tenant: Tenant }> {
  const { email, password, displayName, nurseryName } = params;
  const trimmedNursery = nurseryName.trim();
  if (!trimmedNursery) {
    throw new Error('Nursery name is required.');
  }

  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (displayName.trim()) {
    await updateProfile(cred.user, { displayName: displayName.trim() });
  }

  const tenantId = slugifyNurseryName(trimmedNursery);
  const now = new Date().toISOString();

  const tenant: Tenant = {
    id: tenantId,
    name: trimmedNursery,
    createdAt: now,
    ownerId: cred.user.uid,
    modules: [...DEFAULT_NEW_TENANT_MODULES]
  };

  const member: TenantMember = {
    userId: cred.user.uid,
    email: cred.user.email || email.trim(),
    role: 'owner',
    displayName: displayName.trim() || undefined,
    joinedAt: now
  };

  const profile: UserProfile = {
    uid: cred.user.uid,
    email: cred.user.email || email.trim(),
    displayName: displayName.trim() || undefined,
    activeTenantId: tenantId,
    createdAt: now
  };

  // Create identity docs first, then seed weights (avoids rule timing issues in one batch).
  const batch = writeBatch(db);
  batch.set(doc(db, 'tenants', tenantId), {
    name: tenant.name,
    createdAt: tenant.createdAt,
    ownerId: tenant.ownerId,
    modules: tenant.modules
  });
  batch.set(doc(db, 'tenants', tenantId, 'members', cred.user.uid), member);
  batch.set(doc(db, 'users', cred.user.uid), profile);
  await batch.commit();

  const weightsBatch = writeBatch(db);
  for (const cw of DEFAULT_CONTAINER_WEIGHTS) {
    weightsBatch.set(doc(db, 'tenants', tenantId, 'containerWeights', cw.id), cw);
  }
  await weightsBatch.commit();

  return { user: cred.user, tenant };
}

export async function signIn(email: string, password: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export async function logOut(): Promise<void> {
  await signOut(auth);
}

export async function setActiveTenantForUser(uid: string, tenantId: string): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { activeTenantId: tenantId });
}

export async function renameTenant(tenantId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Nursery name is required.');
  await updateDoc(doc(db, 'tenants', tenantId), { name: trimmed });
}

export async function updateTenantModules(
  tenantId: string,
  modules: TenantModuleId[]
): Promise<void> {
  await updateDoc(doc(db, 'tenants', tenantId), {
    modules: normalizeModulesList(modules)
  });
}

/** Platform admin: list every nursery workspace. */
export async function listAllTenants(): Promise<Tenant[]> {
  const snap = await getDocs(collection(db, 'tenants'));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Tenant, 'id'>) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function generateInviteCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export async function createTeamInvite(params: {
  tenantId: string;
  tenantName: string;
  role: Exclude<MemberRole, 'owner'>;
  createdBy: string;
}): Promise<TenantInvite> {
  const { tenantId, tenantName, role, createdBy } = params;
  const inviteId = `invite-${Date.now()}`;
  const code = generateInviteCode();
  const now = new Date().toISOString();

  const invite: TenantInvite = {
    id: inviteId,
    code,
    role,
    tenantId,
    tenantName,
    createdBy,
    createdAt: now,
    active: true
  };

  await setDoc(doc(db, 'tenants', tenantId, 'invites', inviteId), invite);
  await setDoc(doc(db, 'inviteCodes', code), {
    tenantId,
    inviteId,
    role,
    tenantName,
    active: true,
    createdAt: now
  });
  return invite;
}

export async function listTeamMembers(tenantId: string): Promise<TenantMember[]> {
  const snap = await getDocs(collection(db, 'tenants', tenantId, 'members'));
  return snap.docs.map((d) => d.data() as TenantMember);
}

export async function removeTeamMember(params: {
  tenantId: string;
  memberUserId: string;
  memberRole: MemberRole;
}): Promise<void> {
  const { tenantId, memberUserId, memberRole } = params;
  if (memberRole === 'owner') {
    throw new Error('Owner cannot be removed from the nursery.');
  }
  await deleteDoc(doc(db, 'tenants', tenantId, 'members', memberUserId));
}

/**
 * Owner/admin-initiated password reset for a team member.
 * Sends Firebase's reset email — the member chooses a new password; the owner never sees it.
 */
export async function sendMemberPasswordReset(memberEmail: string): Promise<void> {
  const email = memberEmail.trim();
  if (!email) throw new Error('This team member has no email on file.');
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
      throw new Error('No login account found for that email.');
    }
    if (code === 'auth/too-many-requests') {
      throw new Error('Too many reset emails sent. Wait a few minutes and try again.');
    }
    throw new Error(err?.message || 'Could not send password reset email.');
  }
}

export async function listActiveInvites(tenantId: string): Promise<TenantInvite[]> {
  const snap = await getDocs(collection(db, 'tenants', tenantId, 'invites'));
  return snap.docs
    .map((d) => d.data() as TenantInvite)
    .filter((inv) => inv.active)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function joinNurseryWithInvite(params: {
  user: User;
  inviteCode: string;
  displayName?: string;
}): Promise<{ tenant: Tenant; member: TenantMember }> {
  // Ensure Firestore requests use a fresh auth token (important right after sign-up).
  await params.user.getIdToken(true);

  const code = params.inviteCode.trim().toUpperCase();
  if (!code) {
    throw new Error('Invite code is required.');
  }

  const codeSnap = await getDoc(doc(db, 'inviteCodes', code));
  if (!codeSnap.exists() || !codeSnap.data()?.active) {
    throw new Error('Invalid or expired invite code.');
  }

  const { tenantId, inviteId, role, tenantName } = codeSnap.data() as {
    tenantId: string;
    inviteId: string;
    role: Exclude<MemberRole, 'owner'>;
    tenantName?: string;
  };

  const now = new Date().toISOString();
  const member: TenantMember = {
    userId: params.user.uid,
    email: params.user.email || '',
    role,
    displayName: params.displayName?.trim() || undefined,
    joinedAt: now
  };

  const profile: UserProfile = {
    uid: params.user.uid,
    email: params.user.email || '',
    displayName: params.displayName?.trim() || undefined,
    activeTenantId: tenantId,
    createdAt: now
  };

  const memberRef = doc(db, 'tenants', tenantId, 'members', params.user.uid);
  // Try to create membership. If it already exists, Firestore rules may treat this as update
  // and reject for non-admin users. In that case, continue and re-link profile below.
  try {
    await setDoc(memberRef, member);
  } catch (err: any) {
    if (!String(err?.message || '').toLowerCase().includes('insufficient permissions')) {
      throw err;
    }
  }

  try {
    await setDoc(doc(db, 'users', params.user.uid), profile, { merge: true });
    await updateDoc(doc(db, 'tenants', tenantId, 'invites', inviteId), { active: false });
    await updateDoc(doc(db, 'inviteCodes', code), { active: false });
  } catch (err: any) {
    if (String(err?.message || '').toLowerCase().includes('insufficient permissions')) {
      throw new Error(
        'Permission denied while linking workspace. Ensure latest Firestore rules are published, then generate a new invite code and try again.'
      );
    }
    throw err;
  }

  const tenant =
    (await getTenant(tenantId)) ||
    ({
      id: tenantId,
      name: tenantName || 'Nursery',
      createdAt: now,
      ownerId: ''
    } satisfies Tenant);

  return { tenant, member };
}

export async function signUpAndJoinNursery(params: {
  email: string;
  password: string;
  displayName: string;
  inviteCode: string;
}): Promise<{ user: User; tenant: Tenant; member: TenantMember }> {
  const cred = await createUserWithEmailAndPassword(auth, params.email.trim(), params.password);
  if (params.displayName.trim()) {
    await updateProfile(cred.user, { displayName: params.displayName.trim() });
  }
  const joined = await joinNurseryWithInvite({
    user: cred.user,
    inviteCode: params.inviteCode,
    displayName: params.displayName
  });
  return { user: cred.user, tenant: joined.tenant, member: joined.member };
}
