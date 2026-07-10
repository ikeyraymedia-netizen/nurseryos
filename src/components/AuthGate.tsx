import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import { Tenant, UserProfile, TenantMember } from '../types';
import {
  getTenant,
  getTenantMembership,
  getUserProfile,
  joinNurseryWithInvite,
  logOut,
  renameTenant,
  signIn,
  signUpAndJoinNursery,
  signUpWithNursery,
  watchAuth
} from '../lib/tenants';
import { setActiveTenant } from '../lib/db';
import { setInventoryTenant } from '../lib/inventory';
import { setCustomersTenant } from '../lib/customers';
import { LogIn, UserPlus } from 'lucide-react';
import { BrandLogo } from './BrandLogo';

interface AuthSession {
  user: User;
  profile: UserProfile;
  tenant: Tenant;
  member: TenantMember;
}

interface AuthGateProps {
  children: (session: AuthSession & { onSignOut: () => Promise<void> }) => ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const TARGET_NURSERY_NAME = 'Bayou Sate Plant Co';
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [member, setMember] = useState<TenantMember | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [signupMode, setSignupMode] = useState<'create' | 'join'>('create');
  const [signinMode, setSigninMode] = useState<'normal' | 'join'>('normal');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [nurseryName, setNurseryName] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  useEffect(() => {
    const unsub = watchAuth(async (nextUser) => {
      setBootError(null);
      setUser(nextUser);

      if (!nextUser) {
        setProfile(null);
        setTenant(null);
        setMember(null);
        setActiveTenant(null);
        setInventoryTenant(null);
        setCustomersTenant(null);
        setAuthReady(true);
        return;
      }

      try {
        const nextProfile = await getUserProfile(nextUser.uid);
        if (!nextProfile?.activeTenantId) {
          setBootError('Your account has no nursery workspace yet. Create a nursery or join with an invite code.');
          setProfile(null);
          setTenant(null);
          setMember(null);
          setActiveTenant(null);
          setInventoryTenant(null);
          setCustomersTenant(null);
          setAuthReady(true);
          return;
        }

        const nextTenant = await getTenant(nextProfile.activeTenantId);
        const nextMember = await getTenantMembership(nextProfile.activeTenantId, nextUser.uid);
        if (!nextTenant || !nextMember) {
          setBootError('Nursery workspace not found. Please contact support or create a new account.');
          setProfile(null);
          setTenant(null);
          setMember(null);
          setActiveTenant(null);
          setInventoryTenant(null);
          setCustomersTenant(null);
          setAuthReady(true);
          return;
        }

        let resolvedTenant = nextTenant;
        const lowerName = nextTenant.name.trim().toLowerCase();
        if (lowerName === 'green valley nursery' || lowerName.startsWith('green valley nursery')) {
          try {
            await renameTenant(nextTenant.id, TARGET_NURSERY_NAME);
            resolvedTenant = { ...nextTenant, name: TARGET_NURSERY_NAME };
          } catch (renameErr) {
            console.warn('Could not auto-rename nursery:', renameErr);
          }
        }

        setProfile(nextProfile);
        setTenant(resolvedTenant);
        setMember(nextMember);
        setActiveTenant(resolvedTenant.id);
        setInventoryTenant(resolvedTenant.id);
        setCustomersTenant(resolvedTenant.id);
        setAuthReady(true);
      } catch (err: any) {
        console.error(err);
        setBootError(err?.message || 'Failed to load nursery workspace.');
        setActiveTenant(null);
        setInventoryTenant(null);
        setCustomersTenant(null);
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  const session = useMemo(() => {
    if (!user || !profile || !tenant || !member) return null;
    return {
      user,
      profile,
      tenant,
      member,
      onSignOut: async () => {
        setActiveTenant(null);
        setInventoryTenant(null);
        setCustomersTenant(null);
        await logOut();
      }
    };
  }, [user, profile, tenant, member]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        if (signupMode === 'join') {
          await signUpAndJoinNursery({
            email,
            password,
            displayName,
            inviteCode
          });
        } else {
          await signUpWithNursery({
            email,
            password,
            displayName,
            nurseryName
          });
        }
      } else {
        const signedInUser = await signIn(email, password);
        if (signinMode === 'join') {
          await joinNurseryWithInvite({
            user: signedInUser,
            inviteCode,
            displayName
          });
        }
      }
    } catch (err: any) {
      console.error(err);
      const message =
        err?.code === 'auth/email-already-in-use'
          ? 'That email already has an account. Sign in instead.'
          : err?.code === 'auth/invalid-credential' || err?.code === 'auth/wrong-password'
            ? 'Email or password is incorrect.'
            : err?.code === 'auth/operation-not-allowed'
              ? 'Email/password sign-in is not enabled on this Firebase project yet.'
              : err?.message || 'Authentication failed.';
      setFormError(message);
    } finally {
      setBusy(false);
    }
  }

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <BrandLogo variant="icon" size="lg" showText={false} className="animate-pulse" />
        <p className="text-sm font-bold text-gray-800 uppercase tracking-wider mt-6">Loading NurseryOS...</p>
      </div>
    );
  }

  if (session) {
    return <>{children(session)}</>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-950 via-emerald-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-emerald-100 overflow-hidden">
        <div className="px-6 pt-6 pb-4 border-b border-emerald-100 bg-gradient-to-b from-white to-emerald-50/40">
          <BrandLogo variant="full" showText={false} className="max-h-52 mx-auto" />
        </div>

        <div className="px-6 pt-5">
          <div className="flex bg-slate-100 p-1 rounded-xl mb-5">
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setFormError(null);
              }}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                mode === 'signup' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
              }`}
            >
              Create nursery
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setFormError(null);
              }}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                mode === 'signin' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
              }`}
            >
              Sign in
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3 pb-6">
            {mode === 'signup' && (
              <>
                <div className="flex bg-slate-50 p-1 rounded-lg gap-1">
                  <button
                    type="button"
                    onClick={() => setSignupMode('create')}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md ${
                      signupMode === 'create' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
                    }`}
                  >
                    New nursery
                  </button>
                  <button
                    type="button"
                    onClick={() => setSignupMode('join')}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md ${
                      signupMode === 'join' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
                    }`}
                  >
                    Join with code
                  </button>
                </div>
                {signupMode === 'create' ? (
                  <label className="block">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      Nursery name
                    </span>
                    <input
                      required
                      value={nurseryName}
                      onChange={(e) => setNurseryName(e.target.value)}
                      placeholder="Green Valley Nursery"
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
                    />
                  </label>
                ) : (
                  <label className="block">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      Invite code
                    </span>
                    <input
                      required
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                      placeholder="ABC123"
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Your name
                  </span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Alex Manager"
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
                  />
                </label>
              </>
            )}

            {mode === 'signin' && (
              <>
                <div className="flex bg-slate-50 p-1 rounded-lg gap-1">
                  <button
                    type="button"
                    onClick={() => setSigninMode('normal')}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md ${
                      signinMode === 'normal' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
                    }`}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => setSigninMode('join')}
                    className={`flex-1 py-1.5 text-[11px] font-bold rounded-md ${
                      signinMode === 'join' ? 'bg-white shadow text-emerald-800' : 'text-slate-500'
                    }`}
                  >
                    Sign in + join code
                  </button>
                </div>
                {signinMode === 'join' && (
                  <>
                    <label className="block">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                        Invite code
                      </span>
                      <input
                        required
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                        placeholder="ABC123"
                        className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                        Your name (optional)
                      </span>
                      <input
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Alex Loader"
                        className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
                      />
                    </label>
                  </>
                )}
              </>
            )}

            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Email
              </span>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@nursery.com"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Password
              </span>
              <input
                required
                type="password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
              />
            </label>

            {(formError || bootError) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {formError || bootError}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-bold text-sm py-3 transition-colors"
            >
              {mode === 'signup' ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
              <span>
                {busy
                  ? 'Please wait...'
                  : mode === 'signup'
                    ? signupMode === 'join'
                      ? 'Join nursery team'
                      : 'Create isolated nursery'
                    : signinMode === 'join'
                      ? 'Sign in and join team'
                      : 'Sign in'}
              </span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
