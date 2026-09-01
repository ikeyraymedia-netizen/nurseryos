import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useT } from '../lib/i18n';
import {
  disablePushNotifications,
  enablePushNotifications,
  isIosDevice,
  isStandalonePwa,
  pushPermissionState,
  sendTestPushNotification,
  syncPushNotificationState
} from '../lib/pushNotifications';

interface PushNotificationPanelProps {
  tenantId: string;
  /** When true, disable action buttons (e.g. while Team modal is busy). */
  disabled?: boolean;
  compact?: boolean;
}

export function PushNotificationPanel({
  tenantId,
  disabled = false,
  compact = false
}: PushNotificationPanelProps) {
  const t = useT();
  const [pushBusy, setPushBusy] = useState(false);
  const [pushConfigured, setPushConfigured] = useState<boolean | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushPermission, setPushPermission] = useState(() => pushPermissionState());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void syncPushNotificationState().then((state) => {
      if (!active) return;
      setPushConfigured(state.configured);
      setPushPermission(state.permission);
      setPushEnabled(state.active);
    });
    return () => {
      active = false;
    };
  }, [tenantId]);

  const boxClass = compact
    ? 'space-y-2'
    : 'rounded-xl border border-ink-100 bg-ink-50/50 px-3 py-3';

  return (
    <div className={boxClass}>
      {!compact ? (
        <p className="text-xs font-bold uppercase text-ink-800 flex items-center gap-1.5">
          <Bell className="h-3.5 w-3.5" />
          {t('teamExtra.pushNotifications')}
        </p>
      ) : null}
      <p className={`text-[11px] text-gray-600 leading-relaxed ${compact ? '' : 'mb-2'}`}>
        {t('teamExtra.pushNotificationsHint')}
      </p>
      {isIosDevice() && !isStandalonePwa() ? (
        <p className="text-[11px] text-amber-700 mb-2 leading-relaxed">{t('teamExtra.pushIosHomeScreen')}</p>
      ) : null}
      {message ? <p className="text-[11px] text-emerald-700 mb-2">{message}</p> : null}
      {error ? <p className="text-[11px] text-red-600 mb-2">{error}</p> : null}
      {!pushConfigured ? (
        <p className="text-[11px] text-amber-700">
          {pushConfigured === null ? t('common.loading') : t('teamExtra.pushNotConfigured')}
        </p>
      ) : pushPermission === 'unsupported' ? (
        <p className="text-[11px] text-gray-500">{t('teamExtra.pushUnsupported')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {pushEnabled && pushPermission === 'granted' ? (
            <>
              <span className="text-[11px] text-emerald-700 font-medium">{t('teamExtra.pushEnabled')}</span>
              <button
                type="button"
                disabled={pushBusy || disabled}
                onClick={() => {
                  setPushBusy(true);
                  setError(null);
                  void disablePushNotifications()
                    .then(() => {
                      setPushEnabled(false);
                      setMessage(t('teamExtra.pushDisable'));
                    })
                    .catch(() => setError(t('teamExtra.pushDisableFailed')))
                    .finally(() => setPushBusy(false));
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {t('teamExtra.pushDisable')}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pushBusy || disabled}
              onClick={() => {
                setPushBusy(true);
                setError(null);
                void enablePushNotifications()
                  .then((result) => {
                    setPushPermission(pushPermissionState());
                    if (result === 'granted') {
                      setPushEnabled(true);
                      setMessage(t('teamExtra.pushEnabled'));
                    } else if (result === 'denied') {
                      setPushEnabled(false);
                      setError(t('teamExtra.pushDenied'));
                    } else {
                      setError(t('teamExtra.pushUnsupported'));
                    }
                  })
                  .catch(() => setError(t('teamExtra.pushEnableFailed')))
                  .finally(() => setPushBusy(false));
              }}
              className="rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
            >
              {t('teamExtra.pushEnable')}
            </button>
          )}
          {pushPermission === 'denied' && !pushEnabled ? (
            <span className="text-[11px] text-amber-700">{t('teamExtra.pushDenied')}</span>
          ) : pushPermission === 'granted' && !pushEnabled ? (
            <span className="text-[11px] text-amber-700">{t('teamExtra.pushResyncNeeded')}</span>
          ) : null}
          {pushEnabled && pushPermission === 'granted' ? (
            <button
              type="button"
              disabled={pushBusy || disabled}
              onClick={() => {
                setPushBusy(true);
                setError(null);
                void sendTestPushNotification(tenantId)
                  .then((result) => {
                    if (result.ok) {
                      setMessage(t('teamExtra.pushTestSent'));
                    } else {
                      setError(result.error || t('teamExtra.pushTestFailed'));
                    }
                  })
                  .finally(() => setPushBusy(false));
              }}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {t('teamExtra.pushTest')}
            </button>
          ) : null}
        </div>
      )}
      {pushConfigured ? (
        <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
          {t('teamExtra.pushPerDeviceHint')} {t('teamExtra.pushSelfActionHint')}
        </p>
      ) : null}
    </div>
  );
}
