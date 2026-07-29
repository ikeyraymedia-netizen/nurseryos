import { FormEvent, ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  CheckSquare,
  ClipboardList,
  Laptop,
  LogIn,
  Package,
  Receipt,
  ShoppingCart,
  Smartphone,
  Tablet,
  Truck,
  UserPlus
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';

const REQUEST_ACCESS_EMAIL = 'hello@nurseryos.app';

const FEATURES = [
  {
    icon: Package,
    title: 'Inventory',
    description: 'Live plant stock, uploads, photos, and availability exports.'
  },
  {
    icon: Truck,
    title: 'Truck building',
    description: 'Build loads, loading checkoff, pull sheets, and BOLs.'
  },
  {
    icon: Receipt,
    title: 'Invoicing',
    description: 'Estimates and invoices from the load — email and pay links when you need them.'
  },
  {
    icon: ShoppingCart,
    title: 'Purchasing',
    description: 'Vendors, POs, bills, and scan vendor invoices into the system.'
  },
  {
    icon: CheckSquare,
    title: 'Tasks',
    description: 'Weekly task board — assign yard and office work, check it off.'
  },
  {
    icon: BarChart3,
    title: 'Reports',
    description: 'Sales and operations reporting in one workspace.'
  }
] as const;

export type AuthPanel = 'signin' | 'join' | 'request';

interface WelcomePageProps {
  authPanel: AuthPanel;
  onAuthPanelChange: (panel: AuthPanel) => void;
  signInWithInvite: boolean;
  onSignInWithInviteChange: (value: boolean) => void;
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  nurseryName: string;
  onNurseryNameChange: (value: string) => void;
  inviteCode: string;
  onInviteCodeChange: (value: string) => void;
  requestMessage: string;
  onRequestMessageChange: (value: string) => void;
  busy: boolean;
  formError: string | null;
  bootError: string | null;
  requestSent: boolean;
  onSubmit: (e: FormEvent) => void;
  onRequestAccess: () => void;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{children}</span>
  );
}

const inputClassName =
  'mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-600/30 focus:border-ink-600';

export function WelcomePage({
  authPanel,
  onAuthPanelChange,
  signInWithInvite,
  onSignInWithInviteChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  displayName,
  onDisplayNameChange,
  nurseryName,
  onNurseryNameChange,
  inviteCode,
  onInviteCodeChange,
  requestMessage,
  onRequestMessageChange,
  busy,
  formError,
  bootError,
  requestSent,
  onSubmit,
  onRequestAccess
}: WelcomePageProps) {
  const submitLabel =
    authPanel === 'join'
      ? 'Join nursery team'
      : signInWithInvite
        ? 'Sign in and join team'
        : 'Sign in';

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-950 via-ink-900 to-slate-900">
      <div className="min-h-screen lg:grid lg:grid-cols-[1.1fr_0.9fr]">
        {/* Marketing */}
        <div className="relative flex flex-col px-6 py-8 sm:px-10 lg:px-12 lg:py-12 xl:px-16">
          <div className="mb-8 lg:mb-10">
            <BrandLogo variant="icon" size="md" showText={true} className="text-white" />
          </div>

          <div className="max-w-xl flex-1">
            <div className="rounded-2xl border border-coral-400/25 bg-coral-500/10 px-4 py-3.5 mb-6">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-coral-500/20 text-coral-300">
                  <Activity className="h-4 w-4" strokeWidth={2.5} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white leading-snug">
                    Everyone on the same live data
                  </p>
                  <p className="mt-1 text-xs sm:text-sm text-slate-300 leading-relaxed">
                    Loaders check trucks on their phone. Office sends invoices from a laptop. Same
                    orders, same inventory, same numbers — updated in real time.
                  </p>
                </div>
              </div>
            </div>

            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-200 mb-5">
              <Smartphone className="h-3.5 w-3.5 text-coral-400" />
              Anytime, any device
            </div>

            <h1 className="text-3xl sm:text-4xl xl:text-[2.75rem] font-black leading-tight text-white tracking-tight">
              Run your nursery from the{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-coral-400">
                yard, the office, or the road
              </span>
              .
            </h1>

            <p className="mt-4 text-base sm:text-lg text-slate-300 leading-relaxed">
              NurseryOS keeps inventory, trucks, invoices, and purchasing in one place — on any phone,
              tablet, or computer. No app store. Just sign in.
            </p>

            <div className="mt-5 flex items-center gap-4 text-slate-400">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Smartphone className="h-4 w-4 text-ink-300" />
                Phone
              </div>
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Tablet className="h-4 w-4 text-ink-300" />
                Tablet
              </div>
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Laptop className="h-4 w-4 text-ink-300" />
                Computer
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div
                  key={title}
                  className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink-700/80 text-coral-300">
                      <Icon className="h-4 w-4" strokeWidth={2.25} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white">{title}</p>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">{description}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onAuthPanelChange('request')}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-coral-600 hover:bg-coral-500 text-white font-bold text-sm px-5 py-3 transition-colors"
            >
              <ClipboardList className="h-4 w-4" />
              Request access
            </button>
          </div>
        </div>

        {/* Auth */}
        <div className="flex items-center justify-center px-4 py-8 sm:px-6 lg:px-8 lg:py-12 bg-slate-50/95 lg:bg-white/98 border-t lg:border-t-0 lg:border-l border-white/10">
          <div className="w-full max-w-md">
            <div className="mb-6 hidden lg:block">
              <BrandLogo variant="full" showText={false} className="max-h-28 mx-auto" />
            </div>

            <div className="bg-white rounded-3xl shadow-xl border border-ink-100 overflow-hidden lg:shadow-2xl">
              <div className="flex bg-slate-100 p-1 m-4 mb-0 rounded-xl">
                <button
                  type="button"
                  onClick={() => onAuthPanelChange('signin')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                    authPanel === 'signin' ? 'bg-white shadow text-ink-800' : 'text-slate-500'
                  }`}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => onAuthPanelChange('join')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                    authPanel === 'join' ? 'bg-white shadow text-ink-800' : 'text-slate-500'
                  }`}
                >
                  Join with code
                </button>
              </div>

              <div className="px-5 pt-4 pb-6">
                {authPanel === 'signin' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
                    Sign in to your nursery workspace.
                  </p>
                )}
                {authPanel === 'join' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
                    Got an invite from your nursery owner? Create your account and join the team.
                  </p>
                )}
                {authPanel === 'request' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
                    Tell us about your nursery and we&apos;ll set up your workspace.
                  </p>
                )}

                {authPanel === 'request' ? (
                  <div className="space-y-3">
                    <label className="block">
                      <FieldLabel>Your name</FieldLabel>
                      <input
                        required
                        value={displayName}
                        onChange={(e) => onDisplayNameChange(e.target.value)}
                        placeholder="Alex Manager"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Nursery name</FieldLabel>
                      <input
                        required
                        value={nurseryName}
                        onChange={(e) => onNurseryNameChange(e.target.value)}
                        placeholder="Green Valley Nursery"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Email</FieldLabel>
                      <input
                        required
                        type="email"
                        value={email}
                        onChange={(e) => onEmailChange(e.target.value)}
                        placeholder="you@nursery.com"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Message (optional)</FieldLabel>
                      <textarea
                        value={requestMessage}
                        onChange={(e) => onRequestMessageChange(e.target.value)}
                        placeholder="Tell us about your operation..."
                        rows={3}
                        className={`${inputClassName} resize-none`}
                      />
                    </label>

                    {requestSent && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                        Opening your email app — send the message to complete your request.
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={busy || !displayName.trim() || !nurseryName.trim() || !email.trim()}
                      onClick={onRequestAccess}
                      className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-coral-600 hover:bg-coral-500 disabled:opacity-60 text-white font-bold text-sm py-3 transition-colors"
                    >
                      <ClipboardList className="h-4 w-4" />
                      {busy ? 'Please wait...' : 'Send access request'}
                    </button>

                    <button
                      type="button"
                      onClick={() => onAuthPanelChange('signin')}
                      className="w-full text-xs font-semibold text-slate-500 hover:text-ink-700"
                    >
                      Already have an account? Sign in
                    </button>
                  </div>
                ) : (
                  <form onSubmit={onSubmit} className="space-y-3">
                    {authPanel === 'join' && (
                      <>
                        <label className="block">
                          <FieldLabel>Invite code</FieldLabel>
                          <input
                            required
                            value={inviteCode}
                            onChange={(e) => onInviteCodeChange(e.target.value.toUpperCase())}
                            placeholder="ABC123"
                            className={`${inputClassName} font-mono`}
                          />
                        </label>
                        <label className="block">
                          <FieldLabel>Your name</FieldLabel>
                          <input
                            value={displayName}
                            onChange={(e) => onDisplayNameChange(e.target.value)}
                            placeholder="Alex Loader"
                            className={inputClassName}
                          />
                        </label>
                      </>
                    )}

                    {authPanel === 'signin' && signInWithInvite && (
                      <>
                        <label className="block">
                          <FieldLabel>Invite code</FieldLabel>
                          <input
                            required
                            value={inviteCode}
                            onChange={(e) => onInviteCodeChange(e.target.value.toUpperCase())}
                            placeholder="ABC123"
                            className={`${inputClassName} font-mono`}
                          />
                        </label>
                        <label className="block">
                          <FieldLabel>Your name (optional)</FieldLabel>
                          <input
                            value={displayName}
                            onChange={(e) => onDisplayNameChange(e.target.value)}
                            placeholder="Alex Loader"
                            className={inputClassName}
                          />
                        </label>
                      </>
                    )}

                    <label className="block">
                      <FieldLabel>Email</FieldLabel>
                      <input
                        required
                        type="email"
                        value={email}
                        onChange={(e) => onEmailChange(e.target.value)}
                        placeholder="you@nursery.com"
                        className={inputClassName}
                      />
                    </label>

                    <label className="block">
                      <FieldLabel>Password</FieldLabel>
                      <input
                        required
                        type="password"
                        minLength={6}
                        value={password}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        placeholder="At least 6 characters"
                        className={inputClassName}
                      />
                    </label>

                    {(formError || bootError) && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        {formError || bootError}
                      </div>
                    )}

                    {authPanel === 'signin' && !signInWithInvite && (
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        Forgot your password? Ask your nursery owner or admin — they can send a reset
                        from <span className="font-semibold text-slate-700">Team</span>.
                      </p>
                    )}

                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-ink-700 hover:bg-ink-800 disabled:opacity-60 text-white font-bold text-sm py-3 transition-colors"
                    >
                      {authPanel === 'join' ? (
                        <UserPlus className="h-4 w-4" />
                      ) : (
                        <LogIn className="h-4 w-4" />
                      )}
                      <span>{busy ? 'Please wait...' : submitLabel}</span>
                    </button>

                    {authPanel === 'signin' && (
                      <button
                        type="button"
                        onClick={() => onSignInWithInviteChange(!signInWithInvite)}
                        className="w-full text-xs font-semibold text-ink-600 hover:text-ink-800"
                      >
                        {signInWithInvite
                          ? 'Sign in without an invite code'
                          : 'Have an invite code? Sign in and join'}
                      </button>
                    )}

                    {authPanel === 'join' && (
                      <button
                        type="button"
                        onClick={() => {
                          onAuthPanelChange('signin');
                          onSignInWithInviteChange(true);
                        }}
                        className="w-full text-xs font-semibold text-ink-600 hover:text-ink-800"
                      >
                        Already have an account? Sign in with your invite
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onAuthPanelChange('request')}
                      className="w-full text-xs font-semibold text-slate-500 hover:text-slate-700"
                    >
                      New nursery? Request access
                    </button>
                  </form>
                )}
              </div>
            </div>

            <p className="mt-4 text-center text-[10px] text-slate-400">
              Questions?{' '}
              <a
                href={`mailto:${REQUEST_ACCESS_EMAIL}`}
                className="font-semibold text-ink-600 hover:text-ink-800"
              >
                {REQUEST_ACCESS_EMAIL}
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export { REQUEST_ACCESS_EMAIL };
