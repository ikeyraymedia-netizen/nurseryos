import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Megaphone, RefreshCw, X } from 'lucide-react';
import { InventoryPlant } from '../types';
import { useLocale, useT } from '../lib/i18n';
import { usePlantDisplay } from '../lib/usePlantDisplay';

type PromoFormat = 'email' | 'social' | 'sms';
type PromoAudience = 'wholesale' | 'retail' | 'ready';

interface PromoResult {
  headline: string;
  body: string;
  hashtags: string;
  imageTip: string;
  photoUrl?: string | null;
  usedPhoto?: boolean;
}

interface PlantPromoModalProps {
  plant: InventoryPlant;
  nurseryName?: string;
  onClose: () => void;
}

export function PlantPromoModal({ plant, nurseryName, onClose }: PlantPromoModalProps) {
  const t = useT();
  const { locale } = useLocale();
  const dp = usePlantDisplay();
  const [format, setFormat] = useState<PromoFormat>('social');
  const [audience, setAudience] = useState<PromoAudience>('wholesale');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoResult | null>(null);
  const [copied, setCopied] = useState<'all' | 'body' | 'subject' | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/generate-plant-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plantName: plant.plantName,
          containerSize: plant.containerSize,
          quantityAvailable: plant.quantityAvailable,
          category: plant.category || null,
          listPrice: plant.listPrice ?? null,
          notes: plant.notes || null,
          photoUrl: plant.photoUrl || null,
          nurseryName: nurseryName || null,
          format,
          audience,
          locale
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || t('inventory.promoFailed'));
      }
      setResult({
        headline: String(data.headline || ''),
        body: String(data.body || ''),
        hashtags: String(data.hashtags || ''),
        imageTip: String(data.imageTip || ''),
        photoUrl: data.photoUrl || plant.photoUrl || null,
        usedPhoto: Boolean(data.usedPhoto)
      });
    } catch (err: any) {
      setError(err?.message || t('inventory.promoFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void generate();
    // Generate once when opened; user can regenerate after changing options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyText(kind: 'all' | 'body' | 'subject', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      // ignore
    }
  }

  const fullPost = result
    ? [result.headline, result.body, result.hashtags].filter(Boolean).join('\n\n')
    : '';

  return (
    <div className="fixed inset-0 z-[180] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-3 sm:p-6">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white border border-slate-200 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-white">
          <div className="min-w-0 flex items-start gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-ink-700/10 text-ink-800 flex items-center justify-center shrink-0">
              <Megaphone className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-black text-slate-900">{t('inventory.promoTitle')}</p>
              <p className="text-xs text-slate-500 truncate">
                {dp.plant(plant.plantName)} · {dp.size(plant.containerSize)}
                {plant.quantityAvailable != null ? ` · ${plant.quantityAvailable}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">{t('inventory.promoIntro')}</p>

          {(plant.photoUrl || result?.photoUrl) && (
            <img
              src={result?.photoUrl || plant.photoUrl || ''}
              alt={dp.plant(plant.plantName)}
              className="h-40 w-full object-cover rounded-xl border border-slate-200"
            />
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-xs">
              <span className="font-bold uppercase text-slate-500">{t('inventory.promoFormat')}</span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as PromoFormat)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="social">{t('inventory.promoFormatSocial')}</option>
                <option value="email">{t('inventory.promoFormatEmail')}</option>
                <option value="sms">{t('inventory.promoFormatSms')}</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-bold uppercase text-slate-500">{t('inventory.promoAudience')}</span>
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value as PromoAudience)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="wholesale">{t('inventory.promoAudienceWholesale')}</option>
                <option value="retail">{t('inventory.promoAudienceRetail')}</option>
                <option value="ready">{t('inventory.promoAudienceReady')}</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void generate()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {loading ? t('inventory.promoGenerating') : t('inventory.promoGenerate')}
            </button>
            {result && (
              <button
                type="button"
                onClick={() => void copyText('all', fullPost)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {copied === 'all' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === 'all' ? t('common.copied') : t('inventory.promoCopyAll')}
              </button>
            )}
          </div>

          {error && (
            <p className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">
              {error}
            </p>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    {format === 'email' ? t('inventory.promoSubject') : t('inventory.promoHeadline')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void copyText('subject', result.headline)}
                    className="text-[11px] font-bold text-ink-700 hover:underline"
                  >
                    {copied === 'subject' ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
                <p className="px-3 py-2.5 text-sm font-semibold text-slate-900 whitespace-pre-wrap">
                  {result.headline || '—'}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    {t('inventory.promoBody')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void copyText('body', result.body)}
                    className="text-[11px] font-bold text-ink-700 hover:underline"
                  >
                    {copied === 'body' ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
                <p className="px-3 py-2.5 text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {result.body}
                </p>
              </div>

              {result.hashtags ? (
                <div className="rounded-xl border border-slate-200 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                    {t('inventory.promoHashtags')}
                  </p>
                  <p className="text-sm text-ink-800">{result.hashtags}</p>
                </div>
              ) : null}

              {result.imageTip ? (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {t('inventory.promoImageTip')}: {result.imageTip}
                  {plant.photoUrl ? (
                    <>
                      {' '}
                      <a
                        href={plant.photoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-ink-700 hover:underline"
                      >
                        {t('inventory.promoOpenPhoto')}
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}

              {!plant.photoUrl && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                  {t('inventory.promoNoPhotoHint')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
