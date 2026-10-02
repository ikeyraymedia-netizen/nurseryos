import { useEffect, useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import { TenantMember } from '../types';
import {
  disconnectQuickbooksUser,
  fetchQuickbooksUserConnections,
  QuickbooksUserConnection,
  startQuickbooksConnect
} from '../lib/quickbooks';
import { memberSalesRepLabel } from '../lib/salesReps';

interface Props {
  tenantId: string;
  currentUserId: string;
  members: TenantMember[];
  canManageOthers: boolean;
}

/** Each rep links their own QuickBooks login so QBO audit history shows them, not the company connector. */
export default function QuickbooksUserLoginsPanel({
  tenantId,
  currentUserId,
  members,
  canManageOthers
}: Props) {
  const [connections, setConnections] = useState<QuickbooksUserConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setConnections(await fetchQuickbooksUserConnections(tenantId));
    } catch (err: any) {
      setError(err?.message || 'Could not load QuickBooks logins.');
    }
  }

  useEffect(() => {
    void load();
  }, [tenantId]);

  const mine = connections.find((c) => c.uid === currentUserId);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await startQuickbooksConnect(tenantId, 'user'));
    } catch (err: any) {
      setError(err?.message || 'Could not start QuickBooks sign-in.');
      setBusy(false);
    }
  }

  async function disconnect(userId: string) {
    setBusy(true);
    setError(null);
    try {
      await disconnectQuickbooksUser(tenantId, userId);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const nameFor = (uid: string) => {
    const m = members.find((x) => x.userId === uid);
    return m ? memberSalesRepLabel(m) : uid;
  };

  return (
    <div className="rounded-lg border border-sky-100 bg-white px-2.5 py-2.5 space-y-2">
      <p className="text-[10px] font-bold uppercase text-sky-900">Sales rep QuickBooks logins</p>
      <p className="text-[11px] text-sky-950/80 leading-relaxed">
        Each rep signs in with their own QuickBooks login once. Invoices and estimates are then
        sent as the tagged sales rep, so QuickBooks audit history shows their name. Reps who
        haven’t connected fall back to the company connection. The rep must be a QuickBooks user
        (admin) in this company.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {mine && !mine.error ? (
          <>
            <span className="text-xs font-semibold text-emerald-800">
              Your login is connected · {new Date(mine.connectedAt).toLocaleDateString()}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disconnect(currentUserId)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[11px] font-bold text-slate-700 disabled:opacity-50"
            >
              <Unlink className="h-3 w-3" />
              Disconnect mine
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void connect()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sky-700 text-white text-xs font-bold disabled:opacity-50"
          >
            <Link2 className="h-3.5 w-3.5" />
            {mine?.error ? 'Reconnect my QuickBooks login' : 'Connect my QuickBooks login'}
          </button>
        )}
      </div>
      {connections.length > 0 && (
        <ul className="space-y-1">
          {connections.map((c) => (
            <li key={c.uid} className="flex items-center justify-between gap-2 text-[11px]">
              <span className={c.error ? 'text-rose-700' : 'text-sky-950'}>
                {nameFor(c.uid)}
                {c.error ? ` · ${c.error}` : ' · connected'}
              </span>
              {canManageOthers && c.uid !== currentUserId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect(c.uid)}
                  className="text-[10px] font-bold text-slate-500 hover:text-slate-800"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
}
