import { useEffect, useMemo, useState } from 'react';
import { LocaleProvider, normalizeLocale, readStoredLocale, useT } from '../lib/i18n';

type PublicPlant = {
  id: string;
  plantName: string;
  containerSize: string;
  category: string | null;
  quantityAvailable?: number;
  listPrice: number | null;
  readyDate: string | null;
  photoUrl: string | null;
};

type PublicAvailabilityPayload = {
  nurseryName: string;
  logoUrl: string | null;
  shippingAddress: string | null;
  slug: string;
  showQty: boolean;
  showPhotos: boolean;
  updatedAt: string;
  plants: PublicPlant[];
};

function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function formatReadyDate(readyDate: string | null | undefined): string {
  const raw = (readyDate || '').trim();
  if (!raw) return '—';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  return raw.slice(0, 10);
}

function groupByCategory(plants: PublicPlant[]) {
  const map = new Map<string, PublicPlant[]>();
  for (const plant of plants) {
    const key = plant.category?.trim() || 'Uncategorized';
    const list = map.get(key) || [];
    list.push(plant);
    map.set(key, list);
  }
  return Array.from(map.entries());
}

function PublicAvailabilityInner({ slug }: { slug: string }) {
  const t = useT();
  const [data, setData] = useState<PublicAvailabilityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch(`/api/public/availability/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        } & Partial<PublicAvailabilityPayload>;
        if (!res.ok) {
          throw new Error(body.error || t('publicAvailability.notFound'));
        }
        return body as PublicAvailabilityPayload;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('publicAvailability.notFound'));
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  const groups = useMemo(() => (data ? groupByCategory(data.plants) : []), [data]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <p className="text-sm font-bold text-slate-600 uppercase tracking-wide">
          {t('publicAvailability.loading')}
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-lg font-black text-slate-900">{t('publicAvailability.unavailable')}</h1>
          <p className="text-sm text-slate-600">{error || t('publicAvailability.notFound')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-start gap-4">
          {data.logoUrl ? (
            <img
              src={data.logoUrl}
              alt=""
              className="h-16 w-16 object-contain rounded-xl border border-slate-100 bg-white shrink-0"
            />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-2xl font-black tracking-tight text-ink-950 uppercase">
              {data.nurseryName}
            </h1>
            <p className="text-sm font-bold text-teal-800 mt-0.5">
              {t('publicAvailability.currentAvailability')}
            </p>
            {data.shippingAddress ? (
              <p className="text-xs text-slate-500 mt-1 whitespace-pre-line">{data.shippingAddress}</p>
            ) : null}
            <p className="text-[11px] text-slate-400 mt-2">
              {t('publicAvailability.updated', {
                date: new Date(data.updatedAt).toLocaleString()
              })}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-8">
        {groups.length === 0 ? (
          <p className="text-sm text-slate-500">{t('publicAvailability.empty')}</p>
        ) : (
          groups.map(([category, plants]) => (
            <section key={category} className="space-y-3">
              <h2 className="text-xs font-black uppercase tracking-wider text-teal-800">
                {category}
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                      {data.showPhotos ? <th className="px-3 py-2.5 w-16">{t('publicAvailability.photo')}</th> : null}
                      <th className="px-3 py-2.5">{t('publicAvailability.plant')}</th>
                      <th className="px-3 py-2.5">{t('publicAvailability.size')}</th>
                      {data.showQty ? (
                        <th className="px-3 py-2.5 text-right">{t('publicAvailability.qty')}</th>
                      ) : null}
                      <th className="px-3 py-2.5 text-right">{t('publicAvailability.price')}</th>
                      <th className="px-3 py-2.5">{t('publicAvailability.ready')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plants.map((plant) => (
                      <tr key={plant.id} className="border-b border-slate-100 last:border-0">
                        {data.showPhotos ? (
                          <td className="px-3 py-2.5">
                            {plant.photoUrl ? (
                              <a href={plant.photoUrl} target="_blank" rel="noreferrer">
                                <img
                                  src={plant.photoUrl}
                                  alt=""
                                  className="h-12 w-12 object-cover rounded-lg border border-slate-100"
                                />
                              </a>
                            ) : (
                              <span className="inline-block h-12 w-12 rounded-lg bg-slate-100" />
                            )}
                          </td>
                        ) : null}
                        <td className="px-3 py-2.5 font-bold text-slate-900">{plant.plantName}</td>
                        <td className="px-3 py-2.5 text-slate-600">{plant.containerSize || '—'}</td>
                        {data.showQty ? (
                          <td className="px-3 py-2.5 text-right font-mono font-bold">
                            {plant.quantityAvailable ?? 0}
                          </td>
                        ) : null}
                        <td className="px-3 py-2.5 text-right text-teal-800 font-semibold">
                          {money(plant.listPrice)}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {formatReadyDate(plant.readyDate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
        <p className="text-center text-[10px] text-slate-400 pb-8">
          {t('publicAvailability.poweredBy')}
        </p>
      </main>
    </div>
  );
}

export function PublicAvailabilityPage({ slug }: { slug: string }) {
  const locale = normalizeLocale(readStoredLocale());
  return (
    <LocaleProvider locale={locale}>
      <PublicAvailabilityInner slug={slug} />
    </LocaleProvider>
  );
}

export function readPublicAvailabilitySlugFromPath(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/a\/([a-z0-9][a-z0-9-]{0,46}[a-z0-9]|[a-z0-9]{2})$/i);
  return match ? match[1].toLowerCase() : null;
}
