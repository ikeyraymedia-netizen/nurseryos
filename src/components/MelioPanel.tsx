import { useEffect, useState } from 'react';
import { Link2, RefreshCw, Unlink } from 'lucide-react';
import {
  createMelioEntity,
  createMelioFundingLink,
  createMelioVerifyLink,
  disconnectMelio,
  fetchMelioConfig,
  fetchMelioStatus,
  MelioEntityInput,
  MelioStatus,
  selectMelioFunding
} from '../lib/melio';
import { mintMelioSonarToken } from '../lib/melioSonar';

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

function MelioTermsNotice() {
  return (
    <p className="text-xs leading-relaxed text-indigo-950">
      By continuing, you accept Melio&apos;s{' '}
      <a
        href="https://melio.com/terms-of-service/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline"
      >
        Terms of Service
      </a>{' '}
      and{' '}
      <a
        href="https://melio.com/privacy-policy/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline"
      >
        Privacy Policy
      </a>
      . Payment services provided by{' '}
      <a
        href="https://melio.com/licenses/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline"
      >
        Melio Solutions Inc.
      </a>{' '}
      (NMLS ID 2376858)
    </p>
  );
}

export default function MelioPanel({
  tenantId,
  nurseryName
}: {
  tenantId: string;
  nurseryName: string;
}) {
  const nursery = nurseryName.trim() || 'This nursery';
  const [status, setStatus] = useState<MelioStatus | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entity, setEntity] = useState<MelioEntityInput>({
    ...EMPTY_ENTITY,
    legalName: nurseryName.trim()
  });
  const [fundingChoice, setFundingChoice] = useState('');
  const [sonarKey, setSonarKey] = useState<string | null>(null);
  const [sonarEnv, setSonarEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [hosted, setHosted] = useState<{ url: string; title: string } | null>(null);
  const selectedAccount = status?.accounts.find((a) => a.id === fundingChoice) || null;

  async function sonarToken(entityId?: string | null) {
    if (!sonarKey) {
      throw new Error(
        'Vendor payments are not available yet.'
      );
    }
    return mintMelioSonarToken({
      publishableKey: sonarKey,
      environment: sonarEnv,
      businessEntityId: entityId
    });
  }

  useEffect(() => {
    if (!hosted) return;
    let origin = '';
    try {
      origin = new URL(hosted.url).origin;
    } catch {
      return;
    }
    function onMessage(event: MessageEvent) {
      let host = '';
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      const fromMelio = host === 'melio.com' || host.endsWith('.melio.com');
      if (event.origin !== origin && !fromMelio) return;
      const data = event.data as {
        type?: string;
        status?: string;
        message?: string;
      };
      if (data?.type !== 'melio:accounts:internal') return;
      if (data.status === 'success') {
        setHosted(null);
        setNotice('Bank account updated.');
        void refresh();
      } else if (data.status === 'cancelled') {
        setHosted(null);
        setNotice('The window was closed before it finished.');
      } else if (data.status === 'error') {
        setError(data.message || 'That step could not be finished.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // refresh is recreated each render; the listener only needs the open link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosted]);

  async function refresh() {
    try {
      const cfg = await fetchMelioConfig();
      if (!cfg.configured) {
        setStatus(null);
        setConfigMessage('Vendor payments are not available yet.');
        return;
      }
      setConfigMessage(null);
      setSonarKey(cfg.sonarPublishableKey);
      setSonarEnv(cfg.environment);
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
      setError(err?.message || 'Could not load vendor payments.');
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
      setError(err?.message || 'Vendor payments could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase text-indigo-900">
          Vendor payments
          {status && (
            <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 border border-indigo-100">
              {status.environment === 'production' ? 'Live' : 'Test mode'}
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
      <div className="rounded-lg border border-indigo-100 bg-white px-2.5 py-2 space-y-1">
        <p className="text-sm font-black text-indigo-950">{nursery}</p>
        <p className="text-[11px] leading-relaxed text-indigo-950/80">
          Only an owner or admin of this nursery can open Settings and see this. Someone signing up
          for NurseryOS does not see it, and the rest of the staff cannot open it.
        </p>
        <p className="text-[11px] leading-relaxed text-indigo-950/80">
          This nursery pays its own vendors. Nobody here needs a Melio login. NurseryOS registers{' '}
          {nursery} for those payments. The business is {nursery}, not a separate account.
        </p>
      </div>
      {status && !sonarKey && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
          Vendor payments are not available yet.
        </p>
      )}

      {configMessage && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
          {configMessage}
        </p>
      )}

      {status && !status.apiOk && (
        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
          Vendor payments could not be reached. Try again in a moment.
        </p>
      )}

      {status && !status.connected && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-indigo-950">
            Register {nursery} for vendor payments
          </p>
          <p className="text-[11px] leading-relaxed text-indigo-950/80">
            The nursery already exists. This form sends {nursery}&apos;s legal details so its
            vendor bills can be paid. It does not create a new nursery.
          </p>
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
            <div className="sm:col-span-2 space-y-2">
              <MelioTermsNotice />
              <button
                type="button"
                disabled={busy || !status.apiOk || !sonarKey}
                onClick={() =>
                  void run(async () => {
                    const token = await sonarToken(null);
                    const result = await createMelioEntity(tenantId, entity, token);
                    setEntity({ ...EMPTY_ENTITY, legalName: nurseryName.trim() });
                    return `${nursery} is registered for vendor payments${
                      result.kycStatus ? ` (${result.kycStatus})` : ''
                    }.`;
                  })
                }
                className={primaryBtn}
              >
                Register {nursery}
              </button>
            </div>
          </div>
        </div>
      )}

      {status?.connected && (
        <div className="space-y-2">
          <MelioTermsNotice />
          <p className="text-xs font-semibold text-ink-800">
            {nursery} is registered for vendor payments
            {status.entityName ? ` as ${status.entityName}` : ''}
            {status.kycStatus ? ` · verification: ${status.kycStatus}` : ''}
          </p>

          <p className="text-[11px] font-semibold text-indigo-950">
            Bank account that pays this nursery&apos;s vendors
          </p>
          {status.fundingAccountId ? (
            <p className="text-[11px] text-emerald-800 font-semibold">
              Paying from{' '}
              {status.fundingAccountName ||
                (status.fundingAccountType === 'card' ? 'card' : 'bank')}
              {status.fundingAccountLast4 ? ` ••••${status.fundingAccountLast4}` : ''}. Vendor
              payments are on in Purchasing → Bills.
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
                  disabled={busy || !sonarKey}
                  onClick={() =>
                    void run(async () => {
                      const token = await sonarToken(status?.entityId);
                      const link = await createMelioVerifyLink(tenantId, selectedAccount.id, token);
                      setHosted({ url: link.url, title: 'Verify bank' });
                      return 'Finish verifying the bank in the window.';
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
              This bank has to be verified before it can pay vendors. Tap Verify to finish.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !sonarKey}
              onClick={() =>
                void run(async () => {
                  const token = await sonarToken(status?.entityId);
                  const link = await createMelioFundingLink(tenantId, token, 'plaid');
                  setHosted({ url: link.url, title: 'Link a bank' });
                  return 'Finish linking the bank in the window.';
                })
              }
              className={primaryBtn}
            >
              <Link2 className="h-3.5 w-3.5" />
              Link a bank
            </button>
            <button
              type="button"
              disabled={busy || !sonarKey}
              onClick={() =>
                void run(async () => {
                  const token = await sonarToken(status?.entityId);
                  const link = await createMelioFundingLink(tenantId, token, 'card');
                  setHosted({ url: link.url, title: 'Add a card' });
                  return 'Finish adding the card in the window.';
                })
              }
              className={secondaryBtn}
            >
              Add a card
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!confirm(`Stop vendor payments for ${nursery}?`)) return;
                void run(async () => {
                  await disconnectMelio(tenantId);
                  return `Vendor payments stopped for ${nursery}.`;
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

      {hosted && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-3">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={hosted.title}
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
              <p className="text-xs font-black text-gray-900">{hosted.title}</p>
              <button
                type="button"
                onClick={() => {
                  setHosted(null);
                  setNotice(null);
                  void refresh();
                }}
                className="text-xs font-bold text-gray-600"
              >
                Close
              </button>
            </div>
            <iframe
              title={hosted.title}
              src={hosted.url}
              allow="payment"
              className="h-[70vh] w-full bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
