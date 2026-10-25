import { FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MultiFactorResolver, User } from 'firebase/auth';
import { ShieldCheck } from 'lucide-react';
import { MfaSetupScreen } from './MfaSetupScreen';
import {
  hasPhoneFactor,
  hasTotpEnrolled,
  isMfaRequiredError,
  memberRequiresMfa,
  mfaResolverFor,
  resolveSignInWithPhone,
  resolveSignInWithTotp,
  sendPhoneSignInCode
} from '../lib/mfa';
import {
  accountRequiresMfa,
  IDLE_TIMEOUT_MS,
  MAX_SESSION_MS,
  mfaSkipAllowed,
  mfaStepUpRequired,
  PASSWORD_MIN_LENGTH
} from '../lib/securityPolicy';
import {
  passkeyCount,
  securityChallenge,
  securityCompleteReset,
  securityConfig,
  securityLoginGate,
  securityLoginResult,
  securityLogout,
  securityLogoutAll,
  securityMfaOk,
  securityMfaStatus,
  securityOpenSession,
  securityPasswordCheck,
  securityRequestReset,
  verifyPasskey
} from '../lib/securityClient';
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
  children: (
    session: AuthSession & {
      onSignOut: () => Promise<void>;
      onSignOutAll: () => Promise<void>;
    }
  ) => ReactNode;
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
  const [mfaResolver, setMfaResolver] = useState<MultiFactorResolver | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaSkipped, setMfaSkipped] = useState(false);
  const [securityStrict, setSecurityStrict] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [passkeys, setPasskeys] = useState(0);
  const [securityBlocked, setSecurityBlocked] = useState(false);
  const [faxNumber, setFaxNumber] = useState('');
  const [resetToken, setResetToken] = useState(
    () => new URLSearchParams(window.location.search).get('melioReset') || ''
  );
  const [resetAsk, setResetAsk] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [phoneVerificationId, setPhoneVerificationId] = useState('');
  const challengeRef = useRef<{ id: string; at: number; purpose: string } | null>(null);
  const ticketRef = useRef('');
  const phoneBoxRef = useRef<HTMLDivElement | null>(null);
  const [, setMfaEnrolledTick] = useState(0);

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

  async function readyChallenge(purpose: 'login' | 'signup' | 'reset'): Promise<string> {
    const current = challengeRef.current;
    if (!current || current.purpose !== purpose) {
      const id = await securityChallenge(purpose);
      challengeRef.current = { id, at: Date.now(), purpose };
    }
    const row = challengeRef.current;
    if (!row) throw new Error('Please try again.');
    const wait = 1600 - (Date.now() - row.at);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    challengeRef.current = null;
    return row.id;
  }

  async function applySecuritySession(nextUser: User, rotate: boolean): Promise<void> {
    const strict = await securityConfig();
    setSecurityStrict(strict);
    if (!strict) {
      setStepUp(false);
      setSecurityBlocked(false);
      return;
    }
    await securityOpenSession(rotate);
    if (!hasTotpEnrolled(nextUser)) {
      setStepUp(false);
      setSecurityBlocked(false);
      return;
    }
    if (rotate) {
      await securityMfaOk();
      setStepUp(false);
    } else {
      const status = await securityMfaStatus();
      setPasskeys(await passkeyCount().catch(() => 0));
      setStepUp(
        mfaStepUpRequired({
          strict: true,
          totpEnrolled: true,
          deviceKnown: status.deviceKnown,
          lastMfaAt: status.lastMfaAt,
          now: Date.now()
        })
      );
    }
    setSecurityBlocked(false);
  }

  async function hydrateSession(nextUser: User, rotate = false): Promise<void> {
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
        try {
          await applySecuritySession(nextUser, rotate);
        } catch (err) {
          setBootError(err instanceof Error ? err.message : 'Sign in again.');
          setSecurityBlocked(true);
        }
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
        try {
          await applySecuritySession(nextUser, rotate);
        } catch (err) {
          setBootError(err instanceof Error ? err.message : 'Sign in again.');
          setSecurityBlocked(true);
        }
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
    try {
      await applySecuritySession(nextUser, rotate);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Sign in again.');
      setSecurityBlocked(true);
    }
    setAuthReady(true);
  }

  useEffect(() => {
    let cancelled = false;
    fetch('/api/security/config')
      .then((res) => (res.ok ? res.json() : { strict: false }))
      .then((data) => {
        if (!cancelled) setSecurityStrict(data?.strict === true);
      })
      .catch(() => {
        if (!cancelled) setSecurityStrict(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        try {
          if (securityStrict) await securityLogout();
        } catch {
          /* still sign out of Firebase */
        }
        clearTenantContexts();
        await logOut();
      },
      onSignOutAll: async () => {
        try {
          if (securityStrict) await securityLogoutAll();
        } catch {
          /* still sign out of Firebase */
        }
        clearTenantContexts();
        await logOut();
      }
    };
  }, [user, profile, tenant, member, guestLocale, securityStrict]);

  useEffect(() => {
    if (!securityStrict || !session) return;
    let lastActivity = Date.now();
    const started = Date.now();
    const mark = () => {
      lastActivity = Date.now();
    };
    const events = ['pointerdown', 'keydown'] as const;
    events.forEach((name) => window.addEventListener(name, mark));
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now - started >= MAX_SESSION_MS || now - lastActivity >= IDLE_TIMEOUT_MS) {
        void session.onSignOut();
      }
    }, 30_000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, mark));
      window.clearInterval(timer);
    };
  }, [securityStrict, session]);

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
    ticketRef.current = '';
    try {
      const strict = await securityConfig();
      setSecurityStrict(strict);
      if (strict && faxNumber.trim()) {
        setFormError(translate(locale, 'auth.authFailed'));
        suppressAuthLoadRef.current = false;
        return;
      }
      if (strict && authPanel === 'join') {
        if (password.length < PASSWORD_MIN_LENGTH) {
          setFormError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
          suppressAuthLoadRef.current = false;
          return;
        }
        await securityPasswordCheck(password);
      }
      let ticket = '';
      if (strict) {
        const purpose = authPanel === 'join' ? 'signup' : 'login';
        const challengeId = await readyChallenge(purpose);
        ticket = await securityLoginGate({
          purpose,
          email,
          challengeId,
          faxNumber
        });
        ticketRef.current = ticket;
      }
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
        await afterPasswordSignIn(signedInUser, locale);
      }

      if (strict && ticket) {
        await securityLoginResult({ outcome: 'success', email, ticket }).catch(() => undefined);
      }
      suppressAuthLoadRef.current = false;
      if (nextUser) {
        await hydrateSession(nextUser, true);
      }
    } catch (err: any) {
      if (isMfaRequiredError(err)) {
        setMfaResolver(mfaResolverFor(err));
        setMfaCode('');
        setPhoneVerificationId('');
        return;
      }
      if (ticketRef.current) {
        await securityLoginResult({
          outcome: 'failure',
          email,
          ticket: ticketRef.current
        }).catch(() => undefined);
      }
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

  async function afterPasswordSignIn(signedInUser: User, locale: AppLocale) {
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

  async function handleMfaSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mfaResolver || busy) return;
    setBusy(true);
    setMfaError(null);
    suppressAuthLoadRef.current = true;
    const locale = effectiveLocale;
    try {
      const signedInUser = phoneVerificationId
        ? await resolveSignInWithPhone(mfaResolver, phoneVerificationId, mfaCode)
        : await resolveSignInWithTotp(mfaResolver, mfaCode);
      await afterPasswordSignIn(signedInUser, locale);
      if (securityStrict && ticketRef.current) {
        await securityLoginResult({
          outcome: 'mfa_success',
          email,
          ticket: ticketRef.current
        }).catch(() => undefined);
      }
      suppressAuthLoadRef.current = false;
      setMfaResolver(null);
      setPhoneVerificationId('');
      await hydrateSession(signedInUser, true);
    } catch (err: any) {
      if (securityStrict && ticketRef.current) {
        await securityLoginResult({
          outcome: 'mfa_failure',
          email,
          ticket: ticketRef.current
        }).catch(() => undefined);
      }
      console.error(err);
      setMfaError(
        err?.code === 'auth/invalid-verification-code'
          ? translate(locale, 'mfa.wrongCode')
          : err?.code === 'auth/code-expired' || err?.code === 'auth/multi-factor-auth-required'
            ? translate(locale, 'mfa.sessionExpired')
            : err?.message || translate(locale, 'auth.authFailed')
      );
    } finally {
      suppressAuthLoadRef.current = false;
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
      ) : session &&
        !mfaSkipped &&
        accountRequiresMfa({
          strict: securityStrict,
          signedIn: true,
          isOwnerOrAdmin: memberRequiresMfa(session.member)
        }) &&
        !hasTotpEnrolled(session.user) ? (
        <MfaSetupScreen
          user={session.user}
          offerMoreFactors={securityStrict}
          onDone={() => {
            void securityMfaOk()
              .catch(() => undefined)
              .finally(() => {
                setStepUp(false);
                setMfaEnrolledTick((n) => n + 1);
              });
          }}
          onSignOut={session.onSignOut}
          onSkip={mfaSkipAllowed(securityStrict) ? () => setMfaSkipped(true) : undefined}
        />
      ) : session && (stepUp || securityBlocked) ? (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
          <BrandLogo variant="icon" size="lg" showText={false} />
          <div className="mt-6 w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
            <h1 className="text-lg font-black text-slate-900">{translate(effectiveLocale, 'mfa.stepUpTitle')}</h1>
            <p className="text-xs text-slate-600">
              {securityBlocked ? bootError : translate(effectiveLocale, 'mfa.stepUpHint')}
            </p>
            {stepUp && passkeys > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void verifyPasskey()
                    .then(() => securityMfaOk())
                    .then(() => setStepUp(false))
                    .catch((err: unknown) =>
                      setBootError(err instanceof Error ? err.message : translate(effectiveLocale, 'auth.authFailed'))
                    )
                    .finally(() => setBusy(false));
                }}
                className="w-full px-3 py-2.5 rounded-xl text-sm font-bold border border-slate-200"
              >
                {translate(effectiveLocale, 'mfa.usePasskey')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void session.onSignOut()}
              className="w-full px-3 py-2.5 rounded-xl text-sm font-bold bg-emerald-700 text-white"
            >
              {translate(effectiveLocale, 'mfa.signInAgain')}
            </button>
          </div>
        </div>
      ) : session ? (
        <>{children(session)}</>
      ) : mfaResolver ? (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
          <BrandLogo variant="icon" size="lg" showText={false} />
          <form
            onSubmit={(e) => void handleMfaSubmit(e)}
            className="mt-6 w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4"
          >
            <div>
              <h1 className="text-lg font-black text-slate-900 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
                {translate(effectiveLocale, 'mfa.signInTitle')}
              </h1>
              <p className="text-xs text-slate-600 mt-1">
                {translate(effectiveLocale, 'mfa.signInHint')}
              </p>
            </div>
            <input
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-lg font-mono tracking-[0.4em] text-center"
              autoFocus
            />
            {mfaError && (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
                {mfaError}
              </p>
            )}
            <div ref={phoneBoxRef} />
            {hasPhoneFactor(mfaResolver) && !phoneVerificationId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const node = phoneBoxRef.current;
                  if (!node) return;
                  setBusy(true);
                  setMfaError(null);
                  void sendPhoneSignInCode(mfaResolver, node)
                    .then((id) => setPhoneVerificationId(id))
                    .catch((err: unknown) =>
                      setMfaError(err instanceof Error ? err.message : translate(effectiveLocale, 'auth.authFailed'))
                    )
                    .finally(() => setBusy(false));
                }}
                className="w-full px-3 py-2 rounded-xl text-sm font-bold border border-slate-200"
              >
                {translate(effectiveLocale, 'mfa.addSms')}
              </button>
            )}
            <button
              type="submit"
              disabled={busy || mfaCode.length !== 6}
              className="w-full px-3 py-2.5 rounded-xl text-sm font-bold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
            >
              {busy
                ? translate(effectiveLocale, 'common.pleaseWait')
                : translate(effectiveLocale, 'mfa.verify')}
            </button>
            <button
              type="button"
              onClick={() => {
                setMfaResolver(null);
                setMfaError(null);
              }}
              className="text-xs font-bold text-slate-500 hover:underline"
            >
              {translate(effectiveLocale, 'mfa.backToSignIn')}
            </button>
          </form>
        </div>
      ) : resetToken ? (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setFormError(null);
              void securityCompleteReset(resetToken, resetPassword, faxNumber)
                .then(() => {
                  setResetToken('');
                  setResetMessage(translate(effectiveLocale, 'mfa.resetSent'));
                  window.history.replaceState({}, '', window.location.pathname);
                })
                .catch((err: unknown) =>
                  setFormError(err instanceof Error ? err.message : translate(effectiveLocale, 'auth.authFailed'))
                )
                .finally(() => setBusy(false));
            }}
            className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4"
          >
            <h1 className="text-lg font-black text-slate-900">{translate(effectiveLocale, 'mfa.resetTitle')}</h1>
            <input
              type="password"
              required
              minLength={12}
              maxLength={256}
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder={translate(effectiveLocale, 'mfa.newPassword')}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl"
            />
            {formError && <p className="text-xs text-rose-700">{formError}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full px-3 py-2.5 rounded-xl text-sm font-bold bg-emerald-700 text-white disabled:opacity-50"
            >
              {translate(effectiveLocale, 'mfa.savePassword')}
            </button>
          </form>
        </div>
      ) : resetAsk ? (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setFormError(null);
              void securityRequestReset(email, faxNumber)
                .then((message) => {
                  setResetMessage(message);
                  setResetAsk(false);
                })
                .catch((err: unknown) =>
                  setFormError(err instanceof Error ? err.message : translate(effectiveLocale, 'auth.authFailed'))
                )
                .finally(() => setBusy(false));
            }}
            className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4"
          >
            <h1 className="text-lg font-black text-slate-900">{translate(effectiveLocale, 'mfa.resetTitle')}</h1>
            <p className="text-xs text-slate-600">{translate(effectiveLocale, 'mfa.resetHint')}</p>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl"
            />
            {formError && <p className="text-xs text-rose-700">{formError}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full px-3 py-2.5 rounded-xl text-sm font-bold bg-emerald-700 text-white disabled:opacity-50"
            >
              {translate(effectiveLocale, 'mfa.resetSend')}
            </button>
            <button type="button" onClick={() => setResetAsk(false)} className="text-xs font-bold text-slate-500">
              {translate(effectiveLocale, 'mfa.backToSignIn')}
            </button>
          </form>
        </div>
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
          formError={resetMessage || formError}
          bootError={bootError}
          requestSent={requestSent}
          onSubmit={handleSubmit}
          onRequestAccess={handleRequestAccess}
          securityStrict={securityStrict}
          onForgotPassword={() => {
            setFormError(null);
            setResetMessage(null);
            setResetAsk(true);
          }}
          faxNumber={faxNumber}
          onFaxChange={setFaxNumber}
        />
      )}
    </LocaleProvider>
  );
}
