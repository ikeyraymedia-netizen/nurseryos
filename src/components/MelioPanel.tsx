import { useEffect, useState } from 'react';
import { Link2, RefreshCw, Unlink } from 'lucide-react';
import {
  createMelioEntity,
  createMelioFundingLink,
  createMelioVerifyLink,
  disconnectMelio,
  fetchMelioConfig,
  fetchMelioStatus,
  linkMelioEntity,
  MelioEntityInput,
  MelioStatus,
  registerMelioWebhook,
  selectMelioFunding
} from '../lib/melio';

const EMPTY_ENTITY: MelioEntityInput = {
  legalName: '',
  ein: '',
  phoneNumber: '',
  businessType: 'llc',
  line1: '',
  city: '',
  state: '',
  postalCode: '',
  ownerFirstName: '',
  ownerLastName: '',
  ownerEmail: '',
  ownerDateOfBirth: ''
};

const ENTITY_FIELDS: Array<{ key: keyof MelioEntityInput; label: string; type?: string }> = [
  { key: 'legalName', label: 'Legal business name' },
  { key: 'ein', label: 'EIN (12-3456789)' },
  { key: 'phoneNumber', label: 'Business phone (+12125551234)' },
  { key: 'line1', label: 'Street address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State (2 letters)' },
  { key: 'postalCode', label: 'ZIP' },
  { key: 'ownerFirstName', label: 'Owner first name' },
  { key: 'ownerLastName', label: 'Owner last name' },
  { key: 'ownerEmail', label: 'Owner email', type: 'email' },
  { key: 'ownerDateOfBirth', label: 'Owner date of birth', type: 'date' }
];

const inputClass =
  'w-full rounded-lg border border-indigo-100 bg-white px-2.5 py-1.5 text-xs text-gray-900';
const primaryBtn =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-700 text-white text-xs font-bold disabled:opacity-50';
const secondaryBtn =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-bold disabled:opacity-50';

export default function MelioPanel({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<MelioStatus | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entityIdInput, setEntityIdInput] = useState('me');
  const [showCreate, setShowCreate] = useState(false);
  const [entity, setEntity] = useState<MelioEntityInput>(EMPTY_ENTITY);
  const [fundingChoice, setFundingChoice] = useState('');
  const selectedAccount = status?.accounts.find((a) => a.id === fundingChoice) || null;

  async function refresh() {
    try {
      const cfg = await fetchMelioConfig();
      if (!cfg.configured) {
        setStatus(null);
        setConfigMessage(
          !cfg.melio
            ? 'Add MELIO_API_KEY (and MELIO_ENV=sandbox) to the server environment, then restart.'
            : 'Firebase Admin is not configured on the server.'
        );
        return;
      }
      setConfigMessage(null);
      const next = await fetchMelioStatus(tenantId);
      setStatus(next);
      setFundingChoice(
        next.fundingAccountId ||
          next.accounts.find((a) => a.isVerified)?.id ||
          next.accounts[0]?.id ||
          ''
      );
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load Melio status.');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Melio request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase text-indigo-900">
          Melio bill pay
          {status && (
            <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 border border-indigo-100">
              {status.environment === 'production' ? 'Live' : 'Sandbox'}
            </span>
          )}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => undefined)}
          className="text-indigo-700 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-indigo-950/80 leading-relaxed">
        Pay vendor bills by ACH through Melio. Vendors don’t need a Melio account.
      </p>

      {configMessage && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
          {configMessage}
        </p>
      )}

      {status && (
        <p className="text-[11px] text-indigo-950/80">
          {status.apiOk
            ? `API key works${status.partnerName ? ` · partner: ${status.partnerName}` : ''}`
            : `Melio API not reachable: ${status.apiError || 'unknown error'}`}
        </p>
      )}

      {status && !status.connected && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-indigo-950">
            Step 1: link your Melio business
          </p>
          <div className="flex gap-2">
            <input
              value={entityIdInput}
              onChange={(e) => setEntityIdInput(e.target.value)}
              placeholder="ent_… or me"
              className={inputClass}
            />
            <button
              type="button"
              disabled={busy || !entityIdInput.trim() || !status.apiOk}
              onClick={() =>
                void run(async () => {
                  await linkMelioEntity(tenantId, entityIdInput.trim());
                  return 'Melio business linked.';
                })
              }
              className={primaryBtn}
            >
              <Link2 className="h-3.5 w-3.5" />
              Link
            </button>
          </div>
          <p className="text-[10px] text-indigo-950/70">
            Use the entity ID Melio gave you, or “me” if your key has one business.
          </p>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="text-[11px] font-bold text-indigo-800 underline"
          >
            {showCreate ? 'Hide' : 'Or create a new business in Melio'}
          </button>
          {showCreate && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ENTITY_FIELDS.map((field) => (
                <label key={field.key} className="text-[10px] font-semibold text-indigo-950/80">
                  {field.label}
                  <input
                    type={field.type || 'text'}
                    value={entity[field.key] || ''}
                    onChange={(e) => setEntity((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className={inputClass}
                  />
                </label>
              ))}
              <label className="text-[10px] font-semibold text-indigo-950/80">
                Business type
                <select
                  value={entity.businessType}
                  onChange={(e) => setEntity((prev) => ({ ...prev, businessType: e.target.value }))}
                  className={inputClass}
                >
                  <option value="llc">LLC</option>
                  <option value="corporation">Corporation</option>
                  <option value="sole-proprietorship">Sole proprietorship</option>
                  <option value="partnership">Partnership</option>
                </select>
              </label>
              <div className="sm:col-span-2">
                <button
                  type="button"
                  disabled={busy || !status.apiOk}
                  onClick={() =>
                    void run(async () => {
                      const result = await createMelioEntity(tenantId, entity);
                      setShowCreate(false);
                      setEntity(EMPTY_ENTITY);
                      return `Business created in Melio (${result.kycStatus || 'pending review'}).`;
                    })
                  }
                  className={primaryBtn}
                >
                  Create business in Melio
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {status?.connected && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink-800">
            {status.entityName || 'Melio business'}
            {status.kycStatus ? ` · verification: ${status.kycStatus}` : ''}
          </p>
          <p className="text-[11px] text-indigo-950/80 font-mono truncate">{status.entityId}</p>

          <p className="text-[11px] font-semibold text-indigo-950">
            Step 2: bank account that pays vendors
          </p>
          {status.fundingAccountId ? (
            <p className="text-[11px] text-emerald-800 font-semibold">
              Paying from {status.fundingAccountName || 'bank'}
              {status.fundingAccountLast4 ? ` ••••${status.fundingAccountLast4}` : ''}. Pay via
              Melio is on in Purchasing → Bills.
            </p>
          ) : (
            <p className="text-[11px] text-amber-900">No funding account chosen yet.</p>
          )}
          {status.accounts.length > 0 && (
            <div className="flex gap-2">
              <select
                value={fundingChoice}
                onChange={(e) => setFundingChoice(e.target.value)}
                className={inputClass}
              >
                <option value="">Choose account…</option>
                {status.accounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.label}
                    {acct.last4 ? ` ••••${acct.last4}` : ''}
                    {acct.isVerified ? '' : ' (not verified)'}
                  </option>
                ))}
              </select>
              {selectedAccount && !selectedAccount.isVerified ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const link = await createMelioVerifyLink(tenantId, selectedAccount.id);
                      window.open(link.url, '_blank', 'noopener,noreferrer');
                      return 'Finish verifying the bank in the Melio tab, then tap refresh here.';
                    })
                  }
                  className={primaryBtn}
                >
                  Verify
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !fundingChoice || fundingChoice === status.fundingAccountId}
                  onClick={() =>
                    void run(async () => {
                      await selectMelioFunding(tenantId, fundingChoice);
                      return 'Funding account saved.';
                    })
                  }
                  className={primaryBtn}
                >
                  Use
                </button>
              )}
            </div>
          )}
          {selectedAccount && !selectedAccount.isVerified && (
            <p className="text-[10px] text-amber-900">
              Melio needs to verify this bank before it can pay vendors. Tap Verify to finish in
              Melio.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const link = await createMelioFundingLink(tenantId);
                  window.open(link.url, '_blank', 'noopener,noreferrer');
                  return 'Finish linking the bank in the Melio tab, then tap refresh here.';
                })
              }
              className={primaryBtn}
            >
              <Link2 className="h-3.5 w-3.5" />
              Link a bank (Plaid)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await registerMelioWebhook(tenantId);
                  return `Webhook registered: ${result.url}`;
                })
              }
              className={secondaryBtn}
              title="Melio sends payment status updates to NurseryOS"
            >
              Register webhook
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!confirm('Disconnect Melio from this nursery?')) return;
                void run(async () => {
                  await disconnectMelio(tenantId);
                  return 'Melio disconnected.';
                });
              }}
              className={secondaryBtn}
            >
              <Unlink className="h-3.5 w-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      )}

      {notice && <p className="text-[11px] font-semibold text-emerald-800">{notice}</p>}
      {error && <p className="text-[11px] font-semibold text-rose-700">{error}</p>}
    </div>
  );
}
