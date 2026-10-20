import { useEffect, useState } from 'react';
import type { VendorBill } from '../types';
import { useT } from '../lib/i18n/context';
import {
  fetchMelioConfig,
  fetchMelioPayContext,
  quoteVendorBillMelio,
  type MelioPayQuote
} from '../lib/melio';
import { mintMelioSonarToken } from '../lib/melioSonar';

function moneyFromCents(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDelivery(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export function MelioPayModal({
  tenantId,
  bills,
  busy,
  onCancel,
  onConfirm
}: {
  tenantId: string;
  bills: VendorBill[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (sonarToken?: string) => Promise<void>;
}) {
  const t = useT();
  const [quote, setQuote] = useState<MelioPayQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sonarMissing, setSonarMissing] = useState(false);
  const billIds = bills.map((bill) => bill.id).join(',');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setQuote(null);
    void (async () => {
      try {
        const [cfg, payContext] = await Promise.all([
          fetchMelioConfig(),
          fetchMelioPayContext(tenantId)
        ]);
        let sonarToken: string | undefined;
        if (cfg.sonarPublishableKey) {
          sonarToken = await mintMelioSonarToken({
            publishableKey: cfg.sonarPublishableKey,
            environment: cfg.environment,
            businessEntityId: payContext.entityId
          });
        }
        if (cancelled) return;
        setSonarMissing(!cfg.sonarPublishableKey);
        const next = await quoteVendorBillMelio({
          tenantId,
          billIds: billIds.split(',').filter(Boolean),
          sonarToken
        });
        if (!cancelled) setQuote(next);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the Melio quote.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, billIds]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="melio-pay-title"
        className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-gray-200 p-4 space-y-3"
      >
        <div>
          <h2 id="melio-pay-title" className="text-sm font-black text-gray-900">
            {t('purchasing.melioPayTitle')}
          </h2>
          {quote && (
            <p className="text-[11px] text-gray-600 mt-0.5">
              {t('purchasing.melioPayTo', {
                vendor: quote.vendorName,
                last4: quote.last4 || '****'
              })}
              {quote.billCount > 1 ? ` · ${quote.billCount}` : ''}
            </p>
          )}
        </div>

        {loading && <p className="text-xs text-gray-600">{t('purchasing.melioQuoteLoading')}</p>}
        {error && <p className="text-xs text-rose-700">{error}</p>}

        {quote && (
          <dl className="rounded-xl border border-gray-200 divide-y divide-gray-100 text-xs">
            <div className="flex items-center justify-between px-3 py-2">
              <dt className="text-gray-600">{t('purchasing.melioBillAmount')}</dt>
              <dd className="font-bold text-gray-900">{moneyFromCents(quote.amountCents)}</dd>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <dt className="text-gray-600">{t('purchasing.melioFee')}</dt>
              <dd className="font-bold text-gray-900">{moneyFromCents(quote.feeCents)}</dd>
            </div>
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
              <dt className="font-bold text-gray-800">{t('purchasing.melioTotalDebit')}</dt>
              <dd className="font-black text-gray-900">{moneyFromCents(quote.totalCents)}</dd>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <dt className="text-gray-600">{t('purchasing.melioDeliveryEstimate')}</dt>
              <dd className="font-bold text-gray-900">
                {quote.deliveryDate ? formatDelivery(quote.deliveryDate) : '—'}
              </dd>
            </div>
          </dl>
        )}

        <p className="text-[11px] leading-relaxed text-gray-600">
          Payment services provided by Melio Solutions Inc. (NMLS ID 2376858).{' '}
          <a
            href="https://melio.com/terms-of-service/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline"
          >
            Terms of Service
          </a>
          {' | '}
          <a
            href="https://melio.com/privacy-policy/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline"
          >
            Privacy Policy
          </a>
        </p>
        {sonarMissing && <p className="text-[10px] text-amber-800">{t('purchasing.melioSonarMissing')}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="text-xs font-bold px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || loading || !quote}
            onClick={() =>
              void (async () => {
                try {
                  const [cfg, payContext] = await Promise.all([
                    fetchMelioConfig(),
                    fetchMelioPayContext(tenantId)
                  ]);
                  const sonarToken = cfg.sonarPublishableKey
                    ? await mintMelioSonarToken({
                        publishableKey: cfg.sonarPublishableKey,
                        environment: cfg.environment,
                        businessEntityId: payContext.entityId
                      })
                    : undefined;
                  await onConfirm(sonarToken);
                } catch (err: unknown) {
                  setError(err instanceof Error ? err.message : 'Could not start the Melio payment.');
                }
              })()
            }
            className="text-xs font-bold px-3 py-2 rounded-lg bg-indigo-700 text-white disabled:opacity-50"
          >
            {t('purchasing.melioConfirmPay')}
          </button>
        </div>
      </div>
    </div>
  );
}
