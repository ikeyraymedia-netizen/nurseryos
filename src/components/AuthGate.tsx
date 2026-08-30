import { FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { Tenant, UserProfile, TenantMember } from '../types';
import {
  getTenant,
  getTenantMembership,
  getUserProfile,
  joinNurseryWithInvite,
  logOut,
  signIn,
  signUpAndJoinNursery,
  updateUserLocale,
  watchAuth
} from '../lib/tenants';
import { setActiveTenant } from '../lib/db';
import { setInventoryTenant } from '../lib/inventory';
import { setCustomersTenant } from '../lib/customers';
import { setDocumentsTenant } from '../lib/documents';
import { setAuditTenant } from '../lib/audit';
import { setTasksTenant } from '../lib/tasks';
import { setVendorsTenant } from '../lib/vendors';
import { setPurchasingTenant } from '../lib/purchasing';
import { setBankFeedTenant } from '../lib/bankFeed';
import { setVendorAvailabilityTenant } from '../lib/vendorAvailability';
import { BrandLogo } from './BrandLogo';
import { bootstrapWorkspaceUrl } from '../lib/workspaceUrl';
import { AuthPanel, WelcomePage } from './WelcomePage';
import { submitAccessRequest } from '../lib/accessRequest';
import {
  AppLocale,
  LocaleProvider,
  normalizeLocale,
  readStoredLocale,
  translate
} from '../lib/i18n';

interface AuthSession {
  user: User;
  profile: UserProfile;
  tenant: Tenant | null;
  member: TenantMember | null;
  locale: AppLocale;
  onRefreshTenant: () => Promise<void>;
  onUpdateLocale: (locale: AppLocale) => Promise<void>;
}

interface AuthGateProps {
  children: (session: AuthSession & { onSignOut: () => Promise<void> }) => ReactNode;
}

function clearTenantContexts() {
  setActiveTenant(null);
  setInventoryTenant(null);
  setCustomersTenant(null);
  setDocumentsTenant(null);
  setAuditTenant(null);
  setTasksTenant(null);
  setVendorsTenant(null);
  setPurchasingTenant(null);
  setBankFeedTenant(null);
  setVendorAvailabilityTenant(null);
}

function bindTenantContexts(tenantId: string) {
  setActiveTenant(tenantId);
  setInventoryTenant(tenantId);
  setCustomersTenant(tenantId);
  setDocumentsTenant(tenantId);
  setAuditTenant(tenantId);
  setTasksTenant(tenantId);
  setVendorsTenant(tenantId);
  setPurchasingTenant(tenantId);
  setBankFeedTenant(tenantId);
  setVendorAvailabilityTenant(tenantId);
}

export function AuthGate({ children }: AuthGateProps) {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [member, setMember] = useState<TenantMember | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [authPanel, setAuthPanel] = useState<AuthPanel>('signin');
  const [signInWithInvite, setSignInWithInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [nurseryName, setNurseryName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [requestMessage, setRequestMessage] = useState('');
  const [guestLocale, setGuestLocale] = useState<AppLocale>(() => readStoredLocale());

  const effectiveLocale = normalizeLocale(profile?.locale ?? guestLocale);

  // Skip/ignore auth-listener loads while signup/join writes the profile (avoids a flash of
  // "no workspace" that leaves the form up after a successful join).
  const suppressAuthLoadRef = useRef(false);
  const submitLockRef = useRef(false);
  const authLoadGenRef = useRef(0);

  async function hydrateSession(nextUser: User): Promise<void> {
    const loadGen = ++authLoadGenRef.current;
    setBootError(null);
    setUser(nextUser);

    const nextProfile = await getUserProfile(nextUser.uid);
    if (loadGen !== authLoadGenRef.current) return;

    const isPlatformAdmin = !!nextProfile?.isPlatformAdmin;

    if (!nextProfile) {
      setBootError(translate(effectiveLocale, 'auth.profileNotFound'));
      setProfile(null);
      setTenant(null);
      setMember(null);
      clearTenantContexts();
      setAuthReady(true);
      return;
    }

    // Seller / platform admin can sign in without a nursery membership.
    if (!nextProfile.activeTenantId) {
      if (isPlatformAdmin) {
        setProfile(nextProfile);
        setTenant(null);
        setMember(null);
        clearTenantContexts();
        setAuthReady(true);
        return;
      }
      setBootError(translate(effectiveLocale, 'auth.noWorkspace'));
      setProfile(null);
      setTenant(null);
      setMember(null);
      clearTenantContexts();
      setAuthReady(true);
      return;
    }

    const nextTenant = await getTenant(nextProfile.activeTenantId);
    const nextMember = await getTenantMembership(nextProfile.activeTenantId, nextUser.uid);
    if (loadGen !== authLoadGenRef.current) return;

    if (!nextTenant || !nextMember) {
      if (isPlatformAdmin) {
        setProfile(nextProfile);
        setTenant(null);
        setMember(null);
        clearTenantContexts();
        setAuthReady(true);
        return;
      }
      setBootError(translate(effectiveLocale, 'auth.workspaceNotFound'));
      setProfile(null);
      setTenant(null);
      setMember(null);
      clearTenantContexts();
      setAuthReady(true);
      return;
    }

    let resolvedTenant = nextTenant;
    if (loadGen !== authLoadGenRef.current) return;

    setProfile(nextProfile);
    setTenant(resolvedTenant);
    setMember(nextMember);
    bindTenantContexts(resolvedTenant.id);
    setAuthReady(true);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join')?.trim();
    if (join) {
      setInviteCode(join.toUpperCase());
      setAuthPanel('join');
    }
  }, []);

  useEffect(() => {
    const unsub = watchAuth(async (nextUser) => {
      if (!nextUser) {
        ++authLoadGenRef.current;
        setBootError(null);
        setUser(null);
        setProfile(null);
        setTenant(null);
        setMember(null);
        clearTenantContexts();
        setAuthReady(true);
        return;
      }

      // createUser / signIn fires onAuthStateChanged before invite/profile writes finish.
      // handleSubmit will hydrate once those writes complete.
      if (suppressAuthLoadRef.current) {
        setUser(nextUser);
        return;
      }

      try {
        await hydrateSession(nextUser);
      } catch (err: any) {
        console.error(err);
        setBootError(err?.message || translate(effectiveLocale, 'auth.loadFailed'));
        clearTenantContexts();
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  const session = useMemo(() => {
    if (!user || !profile) return null;
    const isPlatformAdmin = !!profile.isPlatformAdmin;
    if (!isPlatformAdmin && (!tenant || !member)) return null;
    return {
      user,
      profile,
      tenant,
      member,
      locale: normalizeLocale(profile.locale ?? guestLocale),
      onRefreshTenant: async () => {
        if (!profile.activeTenantId) return;
        const next = await getTenant(profile.activeTenantId);
        if (next) setTenant(next);
      },
      onUpdateLocale: async (locale: AppLocale) => {
        const next = normalizeLocale(locale);
        setGuestLocale(next);
        await updateUserLocale(user.uid, next);
        setProfile((p) => (p ? { ...p, locale: next } : p));
      },
      onSignOut: async () => {
        clearTenantContexts();
        await logOut();
      }
    };
  }, [user, profile, tenant, member, guestLocale]);

  // Before NurseryApp mounts after Firebase auth, mirror storage ↔ URL so
  // refresh restore cannot be lost during the auth loading gap.
  useLayoutEffect(() => {
    if (session) bootstrapWorkspaceUrl();
  }, [session]);

  async function handleRequestAccess() {
    if (busy) return;
    const name = displayName.trim();
    const nursery = nurseryName.trim();
    const mail = email.trim();
    if (!name || !nursery || !mail) {
      setFormError(translate(effectiveLocale, 'welcome.requestMissingFields'));
      return;
    }
    setFormError(null);
    setRequestSent(false);
    setBusy(true);
    try {
      await submitAccessRequest({
        displayName: name,
        nurseryName: nursery,
        email: mail,
        message: requestMessage.trim(),
        locale: effectiveLocale
      });
      setRequestSent(true);
    } catch (err: unknown) {
      setFormError(
        err instanceof Error
          ? err.message
          : translate(effectiveLocale, 'welcome.requestFailed')
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitLockRef.current || busy) return;
    submitLockRef.current = true;
    setFormError(null);
    setBusy(true);
    suppressAuthLoadRef.current = true;
    const locale = effectiveLocale;
    try {
      let nextUser: User | null = null;
      if (authPanel === 'join') {
        const joined = await signUpAndJoinNursery({
          email,
          password,
          displayName,
          inviteCode,
          locale
        });
        nextUser = joined.user;
      } else {
        const signedInUser = await signIn(email, password);
        nextUser = signedInUser;
        if (signInWithInvite) {
          await joinNurseryWithInvite({
            user: signedInUser,
            inviteCode,
            displayName,
            locale
          });
        } else {
          await updateUserLocale(signedInUser.uid, locale);
        }
      }

      suppressAuthLoadRef.current = false;
      if (nextUser) {
        await hydrateSession(nextUser);
      }
    } catch (err: any) {
      console.error(err);
      const message =
        err?.code === 'auth/email-already-in-use'
          ? translate(locale, 'auth.emailInUse')
          : err?.code === 'auth/invalid-credential' || err?.code === 'auth/wrong-password'
            ? translate(locale, 'auth.wrongPassword')
            : err?.code === 'auth/operation-not-allowed'
              ? translate(locale, 'authExtra.emailSignInDisabled')
              : err?.message || translate(locale, 'auth.authFailed');
      setFormError(message);
      // If auth already created the user but join failed, let the listener show boot state.
      suppressAuthLoadRef.current = false;
      setAuthReady(true);
    } finally {
      suppressAuthLoadRef.current = false;
      submitLockRef.current = false;
      setBusy(false);
    }
  }

  function handleLocaleChange(next: AppLocale) {
    const locale = normalizeLocale(next);
    setGuestLocale(locale);
    if (user?.uid) {
      void updateUserLocale(user.uid, locale).then(() => {
        setProfile((p) => (p ? { ...p, locale } : p));
      });
    }
  }

  return (
    <LocaleProvider locale={effectiveLocale} onLocaleChange={handleLocaleChange}>
      {!authReady ? (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
          <BrandLogo variant="icon" size="lg" showText={false} className="animate-pulse" />
          <p className="text-sm font-bold text-gray-800 uppercase tracking-wider mt-6">
            {translate(effectiveLocale, 'auth.loading')}
          </p>
        </div>
      ) : session ? (
        <>{children(session)}</>
      ) : (
        <WelcomePage
          authPanel={authPanel}
          onAuthPanelChange={(panel) => {
            setAuthPanel(panel);
            setFormError(null);
            setRequestSent(false);
            if (panel !== 'signin') setSignInWithInvite(false);
          }}
          signInWithInvite={signInWithInvite}
          onSignInWithInviteChange={setSignInWithInvite}
          email={email}
          onEmailChange={setEmail}
          password={password}
          onPasswordChange={setPassword}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          nurseryName={nurseryName}
          onNurseryNameChange={setNurseryName}
          inviteCode={inviteCode}
          onInviteCodeChange={setInviteCode}
          requestMessage={requestMessage}
          onRequestMessageChange={setRequestMessage}
          busy={busy}
          formError={formError}
          bootError={bootError}
          requestSent={requestSent}
          onSubmit={handleSubmit}
          onRequestAccess={handleRequestAccess}
        />
      )}
    </LocaleProvider>
  );
}
