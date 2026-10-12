import { useEffect, useMemo, useState } from 'react';
import { LocaleProvider, normalizeLocale, readStoredLocale, useT } from '../lib/i18n';
import { formatPhotoDate, formatPhotoDateShort } from '../lib/photoDate';

type PublicPlant = {
  id: string;
  plantName: string;
  containerSize: string;
  category: string | null;
  plantType?: string | null;
  quantityAvailable?: number;
  listPrice: number | null;
  readyDate: string | null;
  photoUrl: string | null;
  photoDate?: string | null;
};

type PublicAvailabilityPayload = {
  nurseryName: string;
  logoUrl: string | null;
  shippingAddress: string | null;
  contactEmail?: string | null;
  contacts?: Array<{ name: string; email: string }>;
  slug: string;
  showQty: boolean;
  showPhotos: boolean;
  updatedAt: string;
  plants: PublicPlant[];
};

type OrderContact = { name: string; company: string; phone: string; notes: string };

const PLANT_TYPE_ORDER = ['Ground Cover', 'Grasses', 'Shrubs', 'Perennials', 'Trees'];
const OTHER_GROUP = 'Other';

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

function groupByPlantType(plants: PublicPlant[]): Array<[string, PublicPlant[]]> {
  const map = new Map<string, PublicPlant[]>();
  for (const plant of plants) {
    const key =
      plant.plantType && PLANT_TYPE_ORDER.includes(plant.plantType) ? plant.plantType : OTHER_GROUP;
    const list = map.get(key) || [];
    list.push(plant);
    map.set(key, list);
  }
  const rank = (key: string) => {
    const i = PLANT_TYPE_ORDER.indexOf(key);
    return i === -1 ? PLANT_TYPE_ORDER.length : i;
  };
  return Array.from(map.entries())
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([group, list]) => [
      group,
      [...list].sort(
        (a, b) =>
          a.plantName.localeCompare(b.plantName, undefined, { sensitivity: 'base' }) ||
          a.containerSize.localeCompare(b.containerSize, undefined, {
            sensitivity: 'base',
            numeric: true
          })
      )
    ]);
}

function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’'`"]/g, '')
    .replace(/[^a-z0-9#&.]+/g, ' ')
    .trim();
}

function plantMatchesSearch(plant: PublicPlant, query: string): boolean {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearch(
    `${plant.plantName} ${plant.containerSize} ${plant.plantType || ''} ${plant.category || ''}`
  );
  return words.every((word) => haystack.includes(word));
}

function readStoredCart(slug: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(`nurseryos-order-${slug}`);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const out: Record<string, number> = {};
    for (const [id, qty] of Object.entries(parsed || {})) {
      const n = Math.floor(Number(qty));
      if (n > 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStoredCart(slug: string, cart: Record<string, number>) {
  try {
    window.localStorage.setItem(`nurseryos-order-${slug}`, JSON.stringify(cart));
  } catch {
    /* storage may be unavailable in private mode */
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'order';
}

async function buildPlantListPdf(params: {
  data: PublicAvailabilityPayload;
  lines: Array<{ plant: PublicPlant; qty: number }>;
  contact: OrderContact;
  labels: Record<string, string>;
}): Promise<{ blob: Blob; filename: string }> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable')
  ]);
  const { data, lines, contact, labels } = params;
  const pdf = new jsPDF('p', 'pt', 'letter');
  const margin = 40;
  const pageWidth = pdf.internal.pageSize.getWidth();
  let y = margin;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text(data.nurseryName, margin, y + 6);
  pdf.setFontSize(12);
  pdf.setTextColor(17, 94, 89);
  pdf.text(labels.orderTitle, pageWidth - margin, y + 6, { align: 'right' });
  pdf.setTextColor(0, 0, 0);
  y += 22;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  if (data.shippingAddress) {
    for (const line of data.shippingAddress.split(/\n/)) {
      pdf.text(line, margin, y);
      y += 11;
    }
  }
  if (data.contactEmail) {
    pdf.text(data.contactEmail, margin, y);
    y += 11;
  }
  pdf.text(`${labels.date}: ${new Date().toLocaleDateString()}`, pageWidth - margin, margin + 22, {
    align: 'right'
  });
  pdf.setTextColor(0, 0, 0);
  y += 10;

  const contactRows: Array<[string, string]> = [
    [labels.name, contact.name],
    [labels.company, contact.company],
    [labels.phone, contact.phone]
  ].filter(([, v]) => v.trim()) as Array<[string, string]>;
  if (contactRows.length) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(labels.orderedBy, margin, y);
    y += 13;
    pdf.setFont('helvetica', 'normal');
    for (const [label, value] of contactRows) {
      pdf.text(`${label}: ${value.trim()}`, margin, y);
      y += 12;
    }
    y += 6;
  }

  let total = 0;
  let anyPrice = false;
  const body = lines.map(({ plant, qty }) => {
    const price = plant.listPrice;
    const lineTotal = price != null ? price * qty : null;
    if (lineTotal != null) {
      total += lineTotal;
      anyPrice = true;
    }
    return [plant.plantName, plant.containerSize || '—', String(qty), money(price), money(lineTotal)];
  });

  autoTable(pdf, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [[labels.plant, labels.size, labels.qty, labels.price, labels.total]],
    body,
    foot: anyPrice ? [['', '', '', labels.estTotal, money(total)]] : undefined,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [17, 94, 89], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [241, 245, 249], textColor: 15, fontStyle: 'bold' },
    columnStyles: {
      1: { cellWidth: 70 },
      2: { cellWidth: 45, halign: 'right' },
      3: { cellWidth: 65, halign: 'right' },
      4: { cellWidth: 70, halign: 'right' }
    }
  });

  let after = ((pdf as any).lastAutoTable?.finalY || y) + 20;
  if (contact.notes.trim()) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    pdf.text(labels.notes, margin, after);
    after += 13;
    pdf.setFont('helvetica', 'normal');
    const wrapped = pdf.splitTextToSize(contact.notes.trim(), pageWidth - margin * 2);
    pdf.text(wrapped, margin, after);
    after += wrapped.length * 12 + 8;
  }
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text(labels.disclaimer, margin, after + 4, { maxWidth: pageWidth - margin * 2 });

  const who = contact.company.trim() || contact.name.trim();
  const date = new Date().toISOString().slice(0, 10);
  return {
    blob: pdf.output('blob'),
    filename: `${safeFileName(`${data.nurseryName}-plant-list${who ? `-${who}` : ''}-${date}`)}.pdf`
  };
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function canSharePdf(): boolean {
  try {
    const file = new File([new Blob(['x'], { type: 'application/pdf' })], 'test.pdf', {
      type: 'application/pdf'
    });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

const MAILTO_BODY_LIMIT = 1600;

function plantListEmailBody(params: {
  lines: Array<{ plant: PublicPlant; qty: number }>;
  contact: OrderContact;
  labels: Record<string, string>;
}): string {
  const { lines, contact, labels } = params;
  const rows = lines.map(
    ({ plant, qty }) => `${qty} x ${plant.plantName}${plant.containerSize ? ` (${plant.containerSize})` : ''}`
  );
  const header = `${labels.emailIntro}\n\n`;
  const footerParts = [
    contact.notes.trim() ? `\n${labels.notes}: ${contact.notes.trim()}` : '',
    [contact.name, contact.company, contact.phone].some((v) => v.trim())
      ? `\n${[contact.name, contact.company, contact.phone].map((v) => v.trim()).filter(Boolean).join(' · ')}`
      : ''
  ];
  const footer = footerParts.join('');
  let body = header;
  let shown = 0;
  for (const row of rows) {
    if ((body + row + footer).length > MAILTO_BODY_LIMIT) break;
    body += `${row}\n`;
    shown += 1;
  }
  if (shown < rows.length) body += `${labels.moreInPdf.replace('{{count}}', String(rows.length - shown))}\n`;
  return body + footer;
}

function PublicAvailabilityInner({ slug }: { slug: string }) {
  const t = useT();
  const [data, setData] = useState<PublicAvailabilityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>(() => readStoredCart(slug));
  const [showOrder, setShowOrder] = useState(false);
  const [contact, setContact] = useState<OrderContact>({ name: '', company: '', phone: '', notes: '' });
  const [downloading, setDownloading] = useState(false);
  const [emailedTo, setEmailedTo] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

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

  useEffect(() => {
    writeStoredCart(slug, cart);
  }, [slug, cart]);

  const filtered = useMemo(
    () => (data ? data.plants.filter((p) => plantMatchesSearch(p, query)) : []),
    [data, query]
  );
  const groups = useMemo(() => groupByPlantType(filtered), [filtered]);

  const orderLines = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.plants.map((p) => [p.id, p]));
    return groupByPlantType(
      Object.keys(cart)
        .map((id) => byId.get(id))
        .filter((p): p is PublicPlant => Boolean(p))
    ).flatMap(([, plants]) => plants.map((plant) => ({ plant, qty: cart[plant.id] })));
  }, [data, cart]);

  const orderUnits = orderLines.reduce((sum, line) => sum + line.qty, 0);
  const orderTotal = orderLines.reduce(
    (sum, line) => sum + (line.plant.listPrice != null ? line.plant.listPrice * line.qty : 0),
    0
  );

  const setQty = (id: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      const n = Math.max(0, Math.floor(qty) || 0);
      if (n > 0) next[id] = n;
      else delete next[id];
      return next;
    });
  };

  const contacts = data?.contacts?.length
    ? data.contacts
    : data?.contactEmail
      ? [{ name: '', email: data.contactEmail }]
      : [];
  const shareSupported = useMemo(() => canSharePdf(), []);

  const buildPdf = async () => {
    if (!data || orderLines.length === 0) return null;
    return buildPlantListPdf({
        data,
        lines: orderLines,
        contact,
        labels: {
          orderTitle: t('publicAvailability.orderTitle'),
          date: t('publicAvailability.date'),
          orderedBy: t('publicAvailability.orderedBy'),
          name: t('publicAvailability.yourName'),
          company: t('publicAvailability.company'),
          phone: t('publicAvailability.phone'),
          plant: t('publicAvailability.plant'),
          size: t('publicAvailability.size'),
          qty: t('publicAvailability.qty'),
          price: t('publicAvailability.price'),
          total: t('publicAvailability.lineTotal'),
          estTotal: t('publicAvailability.estTotal'),
          notes: t('publicAvailability.notes'),
          disclaimer: t('publicAvailability.disclaimer')
        }
      });
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const pdf = await buildPdf();
      if (pdf) saveBlob(pdf.blob, pdf.filename);
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    setDownloading(true);
    try {
      const pdf = await buildPdf();
      if (!pdf) return;
      const file = new File([pdf.blob], pdf.filename, { type: 'application/pdf' });
      await navigator
        .share({
          files: [file],
          title: t('publicAvailability.orderTitle'),
          text: contacts.length ? `${t('publicAvailability.sendTo')} ${contacts.map((c) => c.email).join(', ')}` : undefined
        })
        .catch(() => undefined);
    } finally {
      setDownloading(false);
    }
  };

  const emailDraft = (email: string) => {
    const subject = `${t('publicAvailability.orderTitle')} — ${
      contact.company.trim() || contact.name.trim() || data?.nurseryName || ''
    }`;
    const body = plantListEmailBody({
      lines: orderLines,
      contact,
      labels: {
        emailIntro: t('publicAvailability.emailIntro'),
        notes: t('publicAvailability.notes'),
        moreInPdf: t('publicAvailability.moreInPdf')
      }
    });
    const s = encodeURIComponent(subject);
    const b = encodeURIComponent(body);
    const to = encodeURIComponent(email);
    return {
      mailto: `mailto:${email}?subject=${s}&body=${b}`,
      gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${s}&body=${b}`,
      outlook: `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${s}&body=${b}`
    };
  };

  const handleEmail = (email: string) => {
    if (!data || orderLines.length === 0) return;
    // Open the mail app inside the click; browsers ignore mailto after an await.
    const link = document.createElement('a');
    link.href = emailDraft(email).mailto;
    link.click();
    setEmailedTo(email);
    setDownloading(true);
    window.setTimeout(() => {
      void buildPdf()
        .then((pdf) => {
          if (pdf) saveBlob(pdf.blob, pdf.filename);
        })
        .finally(() => setDownloading(false));
    }, 600);
  };

  const copyEmail = (email: string) => {
    void navigator.clipboard?.writeText(email).then(() => setCopiedEmail(email)).catch(() => undefined);
  };

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

  const renderPhoto = (plant: PublicPlant) =>
    plant.photoUrl ? (
      <a
        href={plant.photoUrl}
        target="_blank"
        rel="noreferrer"
        className="relative block h-12 w-12"
        title={
          plant.photoDate
            ? t('publicAvailability.photoTaken', { date: formatPhotoDate(plant.photoDate) })
            : undefined
        }
      >
        <img
          src={plant.photoUrl}
          alt=""
          className="h-12 w-12 object-cover rounded-lg border border-slate-100"
        />
        {plant.photoDate ? (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[8px] font-bold leading-tight text-white">
            {formatPhotoDateShort(plant.photoDate)}
          </span>
        ) : null}
      </a>
    ) : (
      <span className="inline-block h-12 w-12 rounded-lg bg-slate-100" />
    );

  const renderAddControl = (plantId: string, qty: number) =>
    qty ? (
      <input
        type="number"
        inputMode="numeric"
        min={0}
        value={qty}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setQty(plantId, Number(e.target.value))}
        aria-label={t('publicAvailability.order')}
        className="w-16 rounded-lg border border-teal-500 bg-white px-2 py-1 text-center text-sm font-bold focus:outline-none focus:ring-2 focus:ring-teal-600"
      />
    ) : (
      <button
        type="button"
        onClick={() => setQty(plantId, 1)}
        className="rounded-lg border border-teal-600 px-3 py-1 text-xs font-bold text-teal-800 hover:bg-teal-50"
      >
        {t('publicAvailability.add')}
      </button>
    );

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
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
            <p className="text-sm text-slate-700 mt-1">{t('publicAvailability.tagline')}</p>
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

      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('publicAvailability.searchPlaceholder')}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
          {query.trim() ? (
            <p className="mt-1.5 text-[11px] text-slate-500">
              {t('publicAvailability.searchResults', { count: filtered.length })}
            </p>
          ) : null}
        </div>
      </div>

      <main className={`max-w-5xl mx-auto px-4 py-6 space-y-8 ${orderLines.length ? 'pb-28' : ''}`}>
        {groups.length === 0 ? (
          <p className="text-sm text-slate-500">
            {query.trim() ? t('publicAvailability.noMatches') : t('publicAvailability.empty')}
          </p>
        ) : (
          groups.map(([group, plants]) => (
            <section key={group} className="space-y-3">
              <h2 className="text-xs font-black uppercase tracking-wider text-teal-800">{group}</h2>
              <div className="sm:hidden divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-sm">
                {plants.map((plant) => {
                  const qty = cart[plant.id] || 0;
                  const ready = formatReadyDate(plant.readyDate);
                  return (
                    <div
                      key={plant.id}
                      className={`flex items-center gap-3 px-3 py-2.5 ${qty ? 'bg-teal-50/70' : ''}`}
                    >
                      {data.showPhotos ? <div className="shrink-0">{renderPhoto(plant)}</div> : null}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-900 break-words">{plant.plantName}</p>
                        <p className="text-xs text-slate-600">
                          {[
                            plant.containerSize || null,
                            data.showQty
                              ? `${t('publicAvailability.qty')}: ${plant.quantityAvailable ?? 0}`
                              : null,
                            ready !== '—' ? `${t('publicAvailability.ready')} ${ready}` : null
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        <p className="text-xs font-semibold text-teal-800">{money(plant.listPrice)}</p>
                      </div>
                      <div className="shrink-0">{renderAddControl(plant.id, qty)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden sm:block overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
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
                      <th className="px-3 py-2.5 text-center w-24">{t('publicAvailability.order')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plants.map((plant) => {
                      const qty = cart[plant.id] || 0;
                      return (
                        <tr
                          key={plant.id}
                          className={`border-b border-slate-100 last:border-0 ${qty ? 'bg-teal-50/70' : ''}`}
                        >
                          {data.showPhotos ? (
                            <td className="px-3 py-2.5">{renderPhoto(plant)}</td>
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
                          <td className="px-3 py-2 text-center">{renderAddControl(plant.id, qty)}</td>
                        </tr>
                      );
                    })}
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

      {orderLines.length > 0 && !showOrder ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-teal-200 bg-white shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-slate-800">
              {t('publicAvailability.selectedSummary', {
                lines: orderLines.length,
                units: orderUnits
              })}
              {orderTotal > 0 ? (
                <span className="ml-2 text-teal-800">{money(orderTotal)}</span>
              ) : null}
            </p>
            <button
              type="button"
              onClick={() => setShowOrder(true)}
              className="rounded-xl bg-teal-700 px-4 py-2 text-sm font-bold text-white hover:bg-teal-800"
            >
              {t('publicAvailability.reviewOrder')}
            </button>
          </div>
        </div>
      ) : null}

      {showOrder ? (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
          onClick={() => setShowOrder(false)}
        >
          <div
            className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-black text-slate-900">{t('publicAvailability.orderTitle')}</h2>
              <button
                type="button"
                onClick={() => setShowOrder(false)}
                className="text-sm font-bold text-slate-500 hover:text-slate-900"
              >
                {t('publicAvailability.close')}
              </button>
            </div>

            {orderLines.length === 0 ? (
              <p className="text-sm text-slate-500">{t('publicAvailability.orderEmpty')}</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {orderLines.map(({ plant, qty }) => (
                  <div key={plant.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900 truncate">{plant.plantName}</p>
                      <p className="text-xs text-slate-500">
                        {plant.containerSize || '—'} · {money(plant.listPrice)}
                      </p>
                    </div>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={qty}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setQty(plant.id, Number(e.target.value))}
                      className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-center text-sm font-bold"
                    />
                    <button
                      type="button"
                      onClick={() => setQty(plant.id, 0)}
                      className="text-xs font-bold text-rose-600 hover:text-rose-800"
                    >
                      {t('publicAvailability.remove')}
                    </button>
                  </div>
                ))}
                {orderTotal > 0 ? (
                  <div className="flex justify-between px-3 py-2 text-sm font-black">
                    <span>{t('publicAvailability.estTotal')}</span>
                    <span className="text-teal-800">{money(orderTotal)}</span>
                  </div>
                ) : null}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(['name', 'company', 'phone'] as const).map((field) => (
                <input
                  key={field}
                  type={field === 'phone' ? 'tel' : 'text'}
                  value={contact[field]}
                  onChange={(e) => setContact((prev) => ({ ...prev, [field]: e.target.value }))}
                  placeholder={t(
                    field === 'name'
                      ? 'publicAvailability.yourName'
                      : field === 'company'
                        ? 'publicAvailability.company'
                        : 'publicAvailability.phone'
                  )}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              ))}
            </div>
            <textarea
              value={contact.notes}
              onChange={(e) => setContact((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder={t('publicAvailability.notesPlaceholder')}
              rows={2}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
            />

            {contacts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  {t('publicAvailability.emailYourList')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {contacts.map((c) => (
                    <button
                      key={c.email}
                      type="button"
                      onClick={() => handleEmail(c.email)}
                      disabled={orderLines.length === 0 || downloading}
                      className="rounded-xl border border-teal-600 bg-teal-50 px-3 py-2 text-left hover:bg-teal-100 disabled:opacity-50"
                    >
                      {c.name ? (
                        <span className="block text-sm font-black text-teal-900">{c.name}</span>
                      ) : null}
                      <span className="block text-xs text-teal-800 break-all">{c.email}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">{t('publicAvailability.emailHelp')}</p>
                {emailedTo ? (
                  <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-bold">{t('publicAvailability.mailDidntOpen')}</span>
                    <a
                      href={emailDraft(emailedTo).gmail}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-teal-800 underline"
                    >
                      Gmail
                    </a>
                    <a
                      href={emailDraft(emailedTo).outlook}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-teal-800 underline"
                    >
                      Outlook
                    </a>
                    <button
                      type="button"
                      onClick={() => copyEmail(emailedTo)}
                      className="font-bold text-teal-800 underline"
                    >
                      {copiedEmail === emailedTo
                        ? t('publicAvailability.copied')
                        : t('publicAvailability.copyAddress', { email: emailedTo })}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setCart({});
                  setShowOrder(false);
                }}
                className="text-xs font-bold text-slate-500 hover:text-rose-700"
              >
                {t('publicAvailability.clearOrder')}
              </button>
              <div className="flex flex-wrap gap-2">
                {shareSupported ? (
                  <button
                    type="button"
                    onClick={() => void handleShare()}
                    disabled={orderLines.length === 0 || downloading}
                    className="rounded-xl border border-teal-700 px-4 py-2.5 text-sm font-bold text-teal-800 hover:bg-teal-50 disabled:opacity-50"
                  >
                    {t('publicAvailability.sharePdf')}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleDownload()}
                  disabled={orderLines.length === 0 || downloading}
                  className="rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-50"
                >
                  {downloading ? t('publicAvailability.downloading') : t('publicAvailability.downloadOrder')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
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
