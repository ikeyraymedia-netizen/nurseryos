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
import { AppLocale, useLocale, useT } from '../lib/i18n';

const REQUEST_ACCESS_EMAIL = 'hello@nurseryos.app';

const FEATURE_KEYS = [
  { icon: Package, key: 'inventory' },
  { icon: Truck, key: 'trucks' },
  { icon: Receipt, key: 'invoicing' },
  { icon: ShoppingCart, key: 'purchasing' },
  { icon: CheckSquare, key: 'tasks' },
  { icon: BarChart3, key: 'reports' }
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

function LanguageSelect() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <label className="block">
      <FieldLabel>{t('language.label')}</FieldLabel>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as AppLocale)}
        className={inputClassName}
      >
        <option value="en">{t('language.english')}</option>
        <option value="es">{t('language.spanish')}</option>
      </select>
      <p className="mt-1 text-[10px] text-slate-500 leading-relaxed">{t('language.hint')}</p>
    </label>
  );
}

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
  const t = useT();
  const submitLabel =
    authPanel === 'join'
      ? t('welcome.joinNurseryTeam')
      : signInWithInvite
        ? t('welcome.signInAndJoin')
        : t('welcome.signIn');

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink-950 via-ink-900 to-slate-900">
      <div className="min-h-screen lg:grid lg:grid-cols-[1.1fr_0.9fr]">
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
                  <p className="text-sm font-bold text-white leading-snug">{t('welcome.liveDataTitle')}</p>
                  <p className="mt-1 text-xs sm:text-sm text-slate-300 leading-relaxed">
                    {t('welcome.liveDataBody')}
                  </p>
                </div>
              </div>
            </div>

            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-200 mb-5">
              <Smartphone className="h-3.5 w-3.5 text-coral-400" />
              {t('welcome.anytimeBadge')}
            </div>

            <h1 className="text-3xl sm:text-4xl xl:text-[2.75rem] font-black leading-tight text-white tracking-tight">
              {t('welcome.headline')}
            </h1>

            <p className="mt-4 text-base sm:text-lg text-slate-300 leading-relaxed">{t('welcome.subhead')}</p>

            <div className="mt-5 flex items-center gap-4 text-slate-400">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Smartphone className="h-4 w-4 text-ink-300" />
                {t('welcome.phone')}
              </div>
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Tablet className="h-4 w-4 text-ink-300" />
                {t('welcome.tablet')}
              </div>
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Laptop className="h-4 w-4 text-ink-300" />
                {t('welcome.computer')}
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {FEATURE_KEYS.map(({ icon: Icon, key }) => (
                <div
                  key={key}
                  className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink-700/80 text-coral-300">
                      <Icon className="h-4 w-4" strokeWidth={2.25} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white">
                        {t(`welcome.features.${key}.title`)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                        {t(`welcome.features.${key}.description`)}
                      </p>
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
              {t('welcome.requestAccess')}
            </button>
          </div>
        </div>

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
                  {t('welcome.signIn')}
                </button>
                <button
                  type="button"
                  onClick={() => onAuthPanelChange('join')}
                  className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                    authPanel === 'join' ? 'bg-white shadow text-ink-800' : 'text-slate-500'
                  }`}
                >
                  {t('welcome.joinWithCode')}
                </button>
              </div>

              <div className="px-5 pt-4 pb-6">
                {authPanel === 'signin' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">{t('welcome.signInHint')}</p>
                )}
                {authPanel === 'join' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">{t('welcome.joinHint')}</p>
                )}
                {authPanel === 'request' && (
                  <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">{t('welcome.requestHint')}</p>
                )}

                {authPanel === 'request' ? (
                  <div className="space-y-3">
                    <LanguageSelect />
                    <label className="block">
                      <FieldLabel>{t('common.yourName')}</FieldLabel>
                      <input
                        required
                        value={displayName}
                        onChange={(e) => onDisplayNameChange(e.target.value)}
                        placeholder="Alex Manager"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>{t('welcome.nurseryName')}</FieldLabel>
                      <input
                        required
                        value={nurseryName}
                        onChange={(e) => onNurseryNameChange(e.target.value)}
                        placeholder="Green Valley Nursery"
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>{t('common.email')}</FieldLabel>
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
                      <FieldLabel>{t('welcome.messageOptional')}</FieldLabel>
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
                        {t('welcome.requestSent')}
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={busy || !displayName.trim() || !nurseryName.trim() || !email.trim()}
                      onClick={onRequestAccess}
                      className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-coral-600 hover:bg-coral-500 disabled:opacity-60 text-white font-bold text-sm py-3 transition-colors"
                    >
                      <ClipboardList className="h-4 w-4" />
                      {busy ? t('common.pleaseWait') : t('welcome.sendAccessRequest')}
                    </button>

                    <button
                      type="button"
                      onClick={() => onAuthPanelChange('signin')}
                      className="w-full text-xs font-semibold text-slate-500 hover:text-ink-700"
                    >
                      {t('welcome.alreadyHaveAccount')}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={onSubmit} className="space-y-3">
                    <LanguageSelect />

                    {authPanel === 'join' && (
                      <>
                        <label className="block">
                          <FieldLabel>{t('welcome.inviteCode')}</FieldLabel>
                          <input
                            required
                            value={inviteCode}
                            onChange={(e) => onInviteCodeChange(e.target.value.toUpperCase())}
                            placeholder="ABC123"
                            className={`${inputClassName} font-mono`}
                          />
                        </label>
                        <label className="block">
                          <FieldLabel>{t('common.yourName')}</FieldLabel>
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
                          <FieldLabel>{t('welcome.inviteCode')}</FieldLabel>
                          <input
                            required
                            value={inviteCode}
                            onChange={(e) => onInviteCodeChange(e.target.value.toUpperCase())}
                            placeholder="ABC123"
                            className={`${inputClassName} font-mono`}
                          />
                        </label>
                        <label className="block">
                          <FieldLabel>
                            {t('common.yourName')} ({t('common.optional')})
                          </FieldLabel>
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
                      <FieldLabel>{t('common.email')}</FieldLabel>
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
                      <FieldLabel>{t('common.password')}</FieldLabel>
                      <input
                        required
                        type="password"
                        minLength={6}
                        value={password}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        placeholder={t('welcome.atLeast6Chars')}
                        className={inputClassName}
                      />
                    </label>

                    {(formError || bootError) && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        {formError || bootError}
                      </div>
                    )}

                    {authPanel === 'signin' && !signInWithInvite && (
                      <p className="text-[11px] text-slate-500 leading-relaxed">{t('welcome.forgotPassword')}</p>
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
                      <span>{busy ? t('common.pleaseWait') : submitLabel}</span>
                    </button>

                    {authPanel === 'signin' && (
                      <button
                        type="button"
                        onClick={() => onSignInWithInviteChange(!signInWithInvite)}
                        className="w-full text-xs font-semibold text-ink-600 hover:text-ink-800"
                      >
                        {signInWithInvite
                          ? t('welcome.signInWithoutInvite')
                          : t('welcome.haveInviteSignIn')}
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
                        {t('welcome.alreadyHaveAccountInvite')}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onAuthPanelChange('request')}
                      className="w-full text-xs font-semibold text-slate-500 hover:text-slate-700"
                    >
                      {t('welcome.newNurseryRequest')}
                    </button>
                  </form>
                )}
              </div>
            </div>

            <p className="mt-4 text-center text-[10px] text-slate-400">
              {t('welcome.questions')}{' '}
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
