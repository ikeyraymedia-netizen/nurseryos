import React, { useEffect, useState } from 'react';

type AcceptPayload = {
  nurseryName: string;
  documentNumber: string;
  customerName: string;
  grandTotal: number;
  acceptanceStatus: 'pending' | 'accepted';
  acceptedAt?: string | null;
  acceptedByName?: string | null;
};

function money(n: number): string {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function EstimateAcceptInner({ token }: { token: string }) {
  const [data, setData] = useState<AcceptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [acceptedByName, setAcceptedByName] = useState('');
  const [doneAt, setDoneAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch(`/api/public/estimate-accept/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        } & Partial<AcceptPayload>;
        if (!res.ok) throw new Error(body.error || 'Could not load estimate.');
        return body as AcceptPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        if (payload.acceptanceStatus === 'accepted') {
          setDoneAt(payload.acceptedAt || new Date().toISOString());
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load estimate.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    if (!data || data.acceptanceStatus === 'accepted' || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/estimate-accept/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptedByName: acceptedByName.trim() || undefined })
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        acceptedAt?: string;
        alreadyAccepted?: boolean;
      };
      if (!res.ok) throw new Error(body.error || 'Could not accept estimate.');
      setDoneAt(body.acceptedAt || new Date().toISOString());
      setData((prev) =>
        prev
          ? {
              ...prev,
              acceptanceStatus: 'accepted',
              acceptedAt: body.acceptedAt || prev.acceptedAt,
              acceptedByName: acceptedByName.trim() || prev.acceptedByName
            }
          : prev
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not accept estimate.');
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <p className="text-sm font-semibold text-slate-600">Loading estimate…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-rose-100 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-black text-slate-900">Accept estimate</h1>
          <p className="mt-2 text-sm text-rose-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const accepted = data.acceptanceStatus === 'accepted' || Boolean(doneAt);

  return (
    <div className="min-h-screen bg-gradient-to-b from-teal-50 to-slate-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-[11px] font-bold uppercase tracking-wider text-teal-800">
          {data.nurseryName}
        </p>
        <h1 className="mt-1 text-2xl font-black text-slate-900">{data.documentNumber}</h1>
        <p className="mt-2 text-sm text-slate-600">
          Prepared for <span className="font-semibold text-slate-800">{data.customerName}</span>
        </p>
        <p className="mt-4 text-3xl font-black text-teal-800 tabular-nums">
          {money(data.grandTotal)}
        </p>

        {accepted ? (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-sm font-bold text-emerald-900">Estimate accepted</p>
            <p className="mt-1 text-xs text-emerald-800">
              {data.nurseryName} has been notified
              {doneAt ? ` · ${new Date(doneAt).toLocaleString()}` : ''}.
            </p>
          </div>
        ) : (
          <form onSubmit={(e) => void handleAccept(e)} className="mt-6 space-y-3">
            <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">
              Your name (optional)
              <input
                value={acceptedByName}
                onChange={(e) => setAcceptedByName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900"
                placeholder="e.g. Jordan Smith"
              />
            </label>
            {error && <p className="text-xs text-rose-700">{error}</p>}
            <button
              type="submit"
              disabled={accepting}
              className="w-full rounded-xl bg-teal-800 hover:bg-teal-900 disabled:opacity-60 text-white text-sm font-black py-3"
            >
              {accepting ? 'Accepting…' : 'Accept estimate'}
            </button>
            <p className="text-[11px] text-slate-500 text-center leading-snug">
              Accepting notifies {data.nurseryName} by email and in the app.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

export function EstimateAcceptPage({ token }: { token: string }) {
  return <EstimateAcceptInner token={token} />;
}
