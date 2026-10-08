import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { User } from 'firebase/auth';
import { BrandLogo } from './BrandLogo';
import { useT } from '../lib/i18n';
import {
  finishTotpEnrollment,
  sendVerificationEmail,
  startTotpEnrollment,
  TotpEnrollment
} from '../lib/mfa';

interface MfaSetupScreenProps {
  user: User;
  onDone: () => void;
  onSignOut: () => void | Promise<void>;
  /** Shown only when two-step login is not switched on for the project yet. */
  onSkip: () => void;
}

type Blocker = 'verify_email' | 'recent_login' | 'not_enabled' | null;

export function MfaSetupScreen({ user, onDone, onSignOut, onSkip }: MfaSetupScreenProps) {
  const t = useT();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifySent, setVerifySent] = useState(false);

  const begin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await user.reload();
      setEnrollment(await startTotpEnrollment(user));
      setBlocker(null);
    } catch (err: any) {
      const errCode = String(err?.code || '');
      if (errCode === 'auth/unverified-email') setBlocker('verify_email');
      else if (errCode === 'auth/requires-recent-login') setBlocker('recent_login');
      else if (errCode === 'auth/operation-not-allowed' || errCode === 'auth/admin-restricted-operation')
        setBlocker('not_enabled');
      else setError(err?.message || t('mfa.setupFailed'));
    } finally {
      setBusy(false);
    }
  }, [user, t]);

  useEffect(() => {
    void begin();
  }, [begin]);

  async function handleSendVerify() {
    setBusy(true);
    setError(null);
    try {
      await sendVerificationEmail(user);
      setVerifySent(true);
    } catch (err: any) {
      setError(err?.message || t('mfa.setupFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleEnroll(e: FormEvent) {
    e.preventDefault();
    if (!enrollment || busy) return;
    setBusy(true);
    setError(null);
    try {
      await finishTotpEnrollment(user, enrollment, code);
      onDone();
    } catch (err: any) {
      const errCode = String(err?.code || '');
      setError(
        errCode === 'auth/invalid-verification-code'
          ? t('mfa.wrongCode')
          : errCode === 'auth/requires-recent-login'
            ? t('mfa.recentLogin')
            : err?.message || t('mfa.setupFailed')
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <BrandLogo variant="icon" size="lg" showText={false} />
      <div className="mt-6 w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-4">
        <div>
          <h1 className="text-lg font-black text-slate-900 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            {t('mfa.setupTitle')}
          </h1>
          <p className="text-xs text-slate-600 mt-1 leading-relaxed">{t('mfa.setupIntro')}</p>
        </div>

        {blocker === 'verify_email' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              {t('mfa.verifyEmailFirst', { email: user.email || '' })}
            </p>
            {verifySent && <p className="text-xs font-bold text-emerald-700">{t('mfa.verifySent')}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSendVerify()}
                className="px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 hover:bg-slate-50"
              >
                {verifySent ? t('mfa.resendVerify') : t('mfa.sendVerify')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void begin()}
                className="px-3 py-2 rounded-xl text-xs font-bold bg-ink-700 text-white"
              >
                {t('mfa.iVerified')}
              </button>
            </div>
          </div>
        )}

        {blocker === 'recent_login' && <p className="text-sm text-slate-700">{t('mfa.recentLogin')}</p>}

        {blocker === 'not_enabled' && (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">{t('mfa.notEnabled')}</p>
            <button
              type="button"
              onClick={onSkip}
              className="px-3 py-2 rounded-xl text-xs font-bold bg-ink-700 text-white"
            >
              {t('mfa.continueWithout')}
            </button>
          </div>
        )}

        {enrollment && (
          <form onSubmit={(e) => void handleEnroll(e)} className="space-y-4">
            <ol className="text-sm text-slate-700 space-y-1 list-decimal list-inside">
              <li>{t('mfa.step1')}</li>
              <li>{t('mfa.step2')}</li>
              <li>{t('mfa.step3')}</li>
            </ol>
            <div className="flex flex-col items-center gap-2">
              <img
                src={enrollment.qrDataUrl}
                alt={t('mfa.qrAlt')}
                className="h-52 w-52 rounded-lg border border-slate-200"
              />
              <a
                href={enrollment.otpauthUrl}
                className="text-xs font-bold text-ink-700 underline sm:hidden"
              >
                {t('mfa.openOnPhone')}
              </a>
              <p className="text-[11px] text-slate-500 text-center">
                {t('mfa.manualKey')}{' '}
                <span className="font-mono font-bold text-slate-800 break-all select-all">
                  {enrollment.secretKey.match(/.{1,4}/g)?.join(' ')}
                </span>
              </p>
            </div>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('mfa.codeLabel')}</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-xl text-lg font-mono tracking-[0.4em] text-center"
                autoFocus
              />
            </label>
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full px-3 py-2.5 rounded-xl text-sm font-bold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
            >
              {busy ? t('common.pleaseWait') : t('mfa.turnOn')}
            </button>
          </form>
        )}

        {busy && !enrollment && !blocker && (
          <p className="text-xs text-slate-500">{t('common.pleaseWait')}</p>
        )}

        {error && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void onSignOut()}
          className="text-xs font-bold text-slate-500 hover:underline"
        >
          {t('mfa.signOut')}
        </button>
      </div>
    </div>
  );
}
