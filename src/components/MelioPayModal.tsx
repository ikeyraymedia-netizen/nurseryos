import { useEffect, useState } from 'react';
import type { VendorBill } from '../types';
import { useT } from '../lib/i18n/context';
import {
  fetchMelioConfig,
  fetchMelioPayContext,
  quoteVendorBillMelio,
  type MelioMerchantAddress,
  type MelioPayQuote
} from '../lib/melio';
import { mintMelioSonarToken } from '../lib/melioSonar';

const MCC_OPTIONS = [
  '5193',
  '5261',
  '0780',
  '4214',
  '4215',
  '5085',
  '5172',
  '7399'
] as const;

const MCC_LABEL: Record<(typeof MCC_OPTIONS)[number], string> = {
  '5193': 'purchasing.melioMccNursery',
  '5261': 'purchasing.melioMccGarden',
  '0780': 'purchasing.melioMccLandscape',
  '4214': 'purchasing.melioMccFreight',
  '4215': 'purchasing.melioMccCourier',
  '5085': 'purchasing.melioMccSupplies',
  '5172': 'purchasing.melioMccFuel',
  '7399': 'purchasing.melioMccServices'
};

const EMPTY_ADDRESS = { line1: '', line2: '', city: '', state: '', postalCode: '' };

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
  onConfirm: (payment: {
    sonarToken: string;
    merchantCategoryCode?: string;
    goodsReceived?: boolean;
    merchantAddress?: MelioMerchantAddress;
  }) => Promise<void>;
}) {
  const t = useT();
  const [quote, setQuote] = useState<MelioPayQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sonarMissing, setSonarMissing] = useState(false);
  const [mccChoice, setMccChoice] = useState('');
  const [mccOther, setMccOther] = useState('');
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [goodsReceived, setGoodsReceived] = useState(false);
  const billIds = bills.map((bill) => bill.id).join(',');
  const cardFunded = quote?.fundingType === 'card';

  useEffect(() => {
    if (!quote) return;
    const code = quote.merchantCategoryCode || '';
    if ((MCC_OPTIONS as readonly string[]).includes(code)) {
      setMccChoice(code);
      setMccOther('');
    } else if (/^\d{4}$/.test(code)) {
      setMccChoice('other');
      setMccOther(code);
    } else {
      setMccChoice('');
      setMccOther('');
    }
    setAddress({
      line1: quote.merchantAddress?.line1 || '',
      line2: quote.merchantAddress?.line2 || '',
      city: quote.merchantAddress?.city || '',
      state: quote.merchantAddress?.state || '',
      postalCode: quote.merchantAddress?.postalCode || ''
    });
    setGoodsReceived(false);
  }, [quote]);

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
        if (!cfg.sonarPublishableKey) {
          if (!cancelled) setSonarMissing(true);
          return;
        }
        const sonarToken = await mintMelioSonarToken({
          publishableKey: cfg.sonarPublishableKey,
          environment: cfg.environment,
          businessEntityId: payContext.entityId
        });
        if (cancelled) return;
        setSonarMissing(false);
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

  const categoryCode = mccChoice === 'other' ? mccOther.trim() : mccChoice;
  const addressReady = Boolean(
    address.line1.trim() &&
      address.city.trim() &&
      /^[A-Za-z]{2}$/.test(address.state.trim()) &&
      /^\d{5}(-\d{4})?$/.test(address.postalCode.trim())
  );
  const cardDetailsReady = /^\d{4}$/.test(categoryCode) && addressReady;
  const cardReady =
    !cardFunded || (cardDetailsReady && (!quote?.goodsReceivedRequired || goodsReceived));

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="melio-pay-title"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-gray-200 p-4 space-y-3"
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

        {cardFunded && quote && (
          <div className="space-y-2 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
            <p className="text-xs font-semibold text-indigo-950">{t('purchasing.melioCardDetails')}</p>
            <label className="block text-[11px] font-semibold text-gray-700">
              {t('purchasing.melioMcc')}
              <select
                value={mccChoice}
                onChange={(e) => setMccChoice(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
              >
                <option value="">{t('purchasing.melioMccChoose')}</option>
                {MCC_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {t(MCC_LABEL[code])}
                  </option>
                ))}
                <option value="other">{t('purchasing.melioMccOther')}</option>
              </select>
            </label>
            {mccChoice === 'other' && (
              <label className="block text-[11px] font-semibold text-gray-700">
                {t('purchasing.melioMccCode')}
                <input
                  value={mccOther}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={(e) => setMccOther(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
                />
              </label>
            )}
            <p className="text-[11px] font-semibold text-gray-700">{t('purchasing.melioMerchantAddress')}</p>
            <input
              value={address.line1}
              placeholder={t('purchasing.melioMerchantLine1')}
              onChange={(e) => setAddress((prev) => ({ ...prev, line1: e.target.value }))}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
            />
            <input
              value={address.line2}
              placeholder={t('purchasing.melioMerchantLine2')}
              onChange={(e) => setAddress((prev) => ({ ...prev, line2: e.target.value }))}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                value={address.city}
                placeholder={t('purchasing.melioMerchantCity')}
                onChange={(e) => setAddress((prev) => ({ ...prev, city: e.target.value }))}
                className="col-span-3 sm:col-span-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
              />
              <input
                value={address.state}
                placeholder={t('purchasing.melioMerchantState')}
                maxLength={2}
                onChange={(e) =>
                  setAddress((prev) => ({ ...prev, state: e.target.value.toUpperCase().slice(0, 2) }))
                }
                className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
              />
              <input
                value={address.postalCode}
                placeholder={t('purchasing.melioMerchantPostal')}
                onChange={(e) => setAddress((prev) => ({ ...prev, postalCode: e.target.value }))}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
              />
            </div>
            {quote.goodsReceivedRequired && (
              <label className="flex items-start gap-2 text-xs text-gray-800">
                <input
                  type="checkbox"
                  checked={goodsReceived}
                  onChange={(e) => setGoodsReceived(e.target.checked)}
                  className="mt-0.5"
                />
                <span>{t('purchasing.melioGoodsReceived')}</span>
              </label>
            )}
            {!cardDetailsReady && (
              <p className="text-[11px] text-amber-800">{t('purchasing.melioCardIncomplete')}</p>
            )}
          </div>
        )}

        <p className="text-xs leading-relaxed text-gray-800">
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
        <p className="text-[11px] leading-relaxed text-gray-600">{t('purchasing.melioReceiptNote')}</p>
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
            disabled={busy || loading || !quote || !cardReady}
            onClick={() =>
              void (async () => {
                try {
                  const [cfg, payContext] = await Promise.all([
                    fetchMelioConfig(),
                    fetchMelioPayContext(tenantId)
                  ]);
                  if (!cfg.sonarPublishableKey) {
                    setSonarMissing(true);
                    setError(t('purchasing.melioSonarMissing'));
                    return;
                  }
                  const sonarToken = await mintMelioSonarToken({
                    publishableKey: cfg.sonarPublishableKey,
                    environment: cfg.environment,
                    businessEntityId: payContext.entityId
                  });
                  await onConfirm({
                    sonarToken,
                    ...(cardFunded
                      ? {
                          merchantCategoryCode: categoryCode,
                          goodsReceived: quote?.goodsReceivedRequired ? goodsReceived : undefined,
                          merchantAddress: {
                            line1: address.line1.trim(),
                            ...(address.line2.trim() ? { line2: address.line2.trim() } : {}),
                            city: address.city.trim(),
                            state: address.state.trim().toUpperCase(),
                            postalCode: address.postalCode.trim()
                          }
                        }
                      : {})
                  });
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
