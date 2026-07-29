import { useEffect, useRef, useState } from 'react';
import {
  Building2,
  Check,
  LogOut,
  Package,
  ArrowRight,
  ImagePlus,
  Inbox,
  UserPlus
} from 'lucide-react';
import { Tenant, TenantModuleId } from '../types';
import {
  listAllTenants,
  updateTenantModules,
  updateTenantShippingAddress,
  updateTenantLogoUrl,
  resolveNurseryShippingAddress
} from '../lib/tenants';
import {
  TENANT_MODULE_DEFS,
  resolveEnabledModules
} from '../lib/modules';
import {
  fileToCompressedLogoDataUrl,
  resolveNurseryLogoSrc
} from '../lib/nurseryBranding';
import {
  AccessRequest,
  declineAccessRequest,
  deleteNursery,
  listAccessRequests,
  provisionNursery,
  resendOwnerPasswordEmail
} from '../lib/platformAdmin';
import { BrandLogo } from './BrandLogo';

type SellerView = 'nurseries' | 'requests' | 'create';

const DEFAULT_CREATE_MODULES: TenantModuleId[] = ['orders', 'trucks', 'customers'];

interface PlatformDashboardProps {
  userEmail: string;
  homeNursery: Tenant | null;
  canOpenHomeNursery: boolean;
  onOpenHomeNursery: () => void;
  onSignOut: () => Promise<void> | void;
}

export function PlatformDashboard({
  userEmail,
  homeNursery,
  canOpenHomeNursery,
  onOpenHomeNursery,
  onSignOut
}: PlatformDashboardProps) {
  const [view, setView] = useState<SellerView>('nurseries');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TenantModuleId[]>([]);
  const [addressDraft, setAddressDraft] = useState('');
  const [logoDraft, setLogoDraft] = useState('');
  const [legacyAllOn, setLegacyAllOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const logoFileRef = useRef<HTMLInputElement | null>(null);

  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);

  const [createName, setCreateName] = useState('');
  const [createNursery, setCreateNursery] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createModules, setCreateModules] = useState<TenantModuleId[]>([...DEFAULT_CREATE_MODULES]);
  const [createRequestId, setCreateRequestId] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resendingPassword, setResendingPassword] = useState(false);

  function loadDraft(tenant: Tenant) {
    if (tenant.modules == null) {
      setLegacyAllOn(true);
      setDraft([...resolveEnabledModules(tenant)]);
    } else {
      setLegacyAllOn(false);
      setDraft([...resolveEnabledModules(tenant)]);
    }
    setAddressDraft(resolveNurseryShippingAddress(tenant));
    setLogoDraft(tenant.logoUrl?.trim() || '');
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllTenants();
      setTenants(list);
      const preferred =
        list.find((t) => t.id === selectedId) ||
        list.find((t) => t.id === homeNursery?.id) ||
        list[0] ||
        null;
      if (preferred) {
        setSelectedId(preferred.id);
        loadDraft(preferred);
      } else {
        setSelectedId(null);
        setDraft([]);
      }
    } catch (err: any) {
      setError(
        err?.message ||
          'Could not load nurseries. Publish Firestore rules and confirm isPlatformAdmin is true on your user.'
      );
    } finally {
      setLoading(false);
    }
  }

  async function refreshRequests() {
    setRequestsLoading(true);
    setError(null);
    try {
      const list = await listAccessRequests('pending');
      setRequests(list);
    } catch (err: any) {
      setError(err?.message || 'Could not load access requests.');
    } finally {
      setRequestsLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
    refreshRequests().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === 'requests') {
      refreshRequests().catch(() => undefined);
    }
  }, [view]);

  function resetCreateForm() {
    setCreateName('');
    setCreateNursery('');
    setCreateEmail('');
    setCreateModules([...DEFAULT_CREATE_MODULES]);
    setCreateRequestId(null);
  }

  function openCreateFromRequest(req: AccessRequest) {
    setCreateName(req.displayName || '');
    setCreateNursery(req.nurseryName || '');
    setCreateEmail(req.email || '');
    setCreateModules([...DEFAULT_CREATE_MODULES]);
    setCreateRequestId(req.id);
    setView('create');
    setError(null);
    setMessage(null);
  }

  function openBlankCreate() {
    resetCreateForm();
    setView('create');
    setError(null);
    setMessage(null);
  }

  function toggleCreateModule(id: TenantModuleId) {
    setCreateModules((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  async function handleDeclineRequest(req: AccessRequest) {
    if (!confirm(`Decline access request from ${req.nurseryName} (${req.email})?`)) return;
    setRequestActionId(req.id);
    setError(null);
    setMessage(null);
    try {
      await declineAccessRequest(req.id);
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
      setMessage(`Declined ${req.nurseryName}.`);
    } catch (err: any) {
      setError(err?.message || 'Could not decline request.');
    } finally {
      setRequestActionId(null);
    }
  }

  async function handleProvisionNursery() {
    setCreateBusy(true);
    setError(null);
    setMessage(null);
    const approvingId = createRequestId;
    try {
      const result = await provisionNursery({
        displayName: createName,
        nurseryName: createNursery,
        email: createEmail,
        modules: createModules,
        accessRequestId: approvingId || undefined,
        sendWelcomeEmail: true
      });
      setMessage(
        `Created ${createNursery} (${result.tenantId}).${
          result.resetLinkSent
            ? ' Welcome email with password link sent.'
            : ' Nursery created — welcome email was not sent.'
        }${result.warning ? ` Note: ${result.warning}` : ''}`
      );
      resetCreateForm();
      await refresh();
      if (approvingId) {
        setRequests((prev) => prev.filter((r) => r.id !== approvingId));
      }
      setView('nurseries');
      setSelectedId(result.tenantId);
      const list = await listAllTenants();
      const created = list.find((t) => t.id === result.tenantId);
      if (created) loadDraft(created);
    } catch (err: any) {
      setError(err?.message || 'Could not create nursery.');
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleResendPassword() {
    if (!selected) return;
    setResendingPassword(true);
    setError(null);
    setMessage(null);
    try {
      const result = await resendOwnerPasswordEmail(selected.id);
      setMessage(
        result.ownerEmail
          ? `Set-password email resent to ${result.ownerEmail}. Ask them to check inbox and spam.`
          : 'Set-password email resent. Ask them to check inbox and spam.'
      );
    } catch (err: any) {
      setError(err?.message || 'Could not resend password email.');
    } finally {
      setResendingPassword(false);
    }
  }

  async function handleDeleteNursery() {
    if (!selected) return;
    const typed = window.prompt(
      `This permanently deletes "${selected.name}" and all of its data (orders, trucks, inventory, bills, team, etc.).\n\nType the nursery name exactly to confirm:`
    );
    if (typed == null) return;
    if (typed.trim() !== selected.name.trim()) {
      setError('Delete cancelled — the name did not match.');
      setMessage(null);
      return;
    }
    if (!window.confirm(`Really delete ${selected.name}? This cannot be undone.`)) return;

    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await deleteNursery({
        tenantId: selected.id,
        confirmName: selected.name
      });
      setMessage(`Deleted nursery "${result.name}".`);
      setSelectedId(null);
      setDraft([]);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Could not delete nursery.');
    } finally {
      setDeleting(false);
    }
  }

  function selectTenant(id: string) {
    const t = tenants.find((x) => x.id === id);
    if (!t) return;
    setSelectedId(id);
    setMessage(null);
    setError(null);
    loadDraft(t);
  }

  function toggleModule(id: TenantModuleId) {
    setLegacyAllOn(false);
    setDraft((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  async function handleSave() {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await updateTenantModules(selectedId, draft);
      setTenants((prev) =>
        prev.map((t) => (t.id === selectedId ? { ...t, modules: [...draft] } : t))
      );
      setLegacyAllOn(false);
      setMessage('Package saved for this nursery.');
    } catch (err: any) {
      setError(err?.message || 'Failed to save modules.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAddress() {
    if (!selectedId) return;
    setSavingAddress(true);
    setError(null);
    setMessage(null);
    try {
      await updateTenantShippingAddress(selectedId, addressDraft);
      const saved = addressDraft.trim();
      setTenants((prev) =>
        prev.map((t) =>
          t.id === selectedId ? { ...t, shippingAddress: saved || undefined } : t
        )
      );
      setMessage('Ship-from address saved for this nursery.');
    } catch (err: any) {
      setError(err?.message || 'Failed to save ship-from address.');
    } finally {
      setSavingAddress(false);
    }
  }

  async function persistLogo(nextLogoUrl: string | null, successMessage: string) {
    if (!selectedId) return;
    setSavingLogo(true);
    setError(null);
    setMessage(null);
    try {
      await updateTenantLogoUrl(selectedId, nextLogoUrl);
      const saved = nextLogoUrl?.trim() || undefined;
      setLogoDraft(saved || '');
      setTenants((prev) =>
        prev.map((t) => (t.id === selectedId ? { ...t, logoUrl: saved } : t))
      );
      setMessage(successMessage);
    } catch (err: any) {
      setError(err?.message || 'Failed to save nursery logo.');
    } finally {
      setSavingLogo(false);
    }
  }

  async function handleSaveLogoUrl() {
    await persistLogo(logoDraft.trim() || null, 'Nursery logo saved for invoices and BOLs.');
  }

  async function handleClearLogo() {
    await persistLogo(null, 'Custom logo cleared. Built-in branding will be used if available.');
  }

  async function handleLogoFile(file: File | null) {
    if (!file || !selectedId) return;
    setSavingLogo(true);
    setError(null);
    setMessage(null);
    try {
      const dataUrl = await fileToCompressedLogoDataUrl(file);
      await updateTenantLogoUrl(selectedId, dataUrl);
      setLogoDraft(dataUrl);
      setTenants((prev) =>
        prev.map((t) => (t.id === selectedId ? { ...t, logoUrl: dataUrl } : t))
      );
      setMessage('Nursery logo uploaded for invoices and BOLs.');
    } catch (err: any) {
      setError(err?.message || 'Failed to upload nursery logo.');
    } finally {
      setSavingLogo(false);
      if (logoFileRef.current) logoFileRef.current.value = '';
    }
  }

  const selected = tenants.find((t) => t.id === selectedId) || null;
  const logoPreviewSrc = selected
    ? resolveNurseryLogoSrc({
        name: selected.name,
        logoUrl: logoDraft.trim() || selected.logoUrl
      })
    : null;

  function moduleSummary(tenant: Tenant): string {
    if (tenant.modules == null) return 'Legacy · all standard modules';
    if (tenant.modules.length === 0) return 'Not activated · no workspaces';
    return tenant.modules
      .map((id) => TENANT_MODULE_DEFS.find((m) => m.id === id)?.label || id)
      .join(', ');
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandLogo variant="icon" size="md" showText={false} />
            <div>
              <h1 className="text-lg font-black tracking-tight text-white">NurseryOS Seller</h1>
              <p className="text-[11px] text-slate-400 font-mono uppercase tracking-wider">
                Platform · manage nursery packages
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canOpenHomeNursery && homeNursery && (
              <button
                type="button"
                onClick={onOpenHomeNursery}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/30 bg-white/10 px-3 py-2 text-xs font-bold text-white hover:bg-white/20"
              >
                Open {homeNursery.name}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onSignOut()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-slate-700"
              title={userEmail}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8">
        <div className="mb-6 space-y-4">
          <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
            Signed in as <span className="font-bold text-white">{userEmail}</span>. Approve access
            requests, create nurseries, and manage packages from here.
          </p>
          <div className="inline-flex rounded-xl border border-slate-700 overflow-hidden">
            {(
              [
                ['nurseries', 'Nurseries', Building2],
                ['requests', 'Access requests', Inbox],
                ['create', 'Create nursery', UserPlus]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  if (id === 'create' && view !== 'create') {
                    resetCreateForm();
                  }
                  setView(id);
                  setError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
                  view === id
                    ? 'bg-ink-600 text-white'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {id === 'requests' && requests.length > 0 ? ` (${requests.length})` : ''}
              </button>
            ))}
          </div>
          {(error || message) && view !== 'nurseries' && (
            <div className="space-y-1">
              {error && <p className="text-xs text-red-400 font-semibold">{error}</p>}
              {message && <p className="text-xs text-emerald-300 font-semibold">{message}</p>}
            </div>
          )}
        </div>

        {view === 'requests' && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-amber-300" />
                <h2 className="text-sm font-black text-white">Pending access requests</h2>
              </div>
              <button
                type="button"
                onClick={() => refreshRequests()}
                className="text-[11px] font-bold text-slate-300 hover:text-white"
              >
                Refresh
              </button>
            </div>
            {requestsLoading ? (
              <p className="p-4 text-sm text-slate-400">Loading…</p>
            ) : requests.length === 0 ? (
              <p className="p-4 text-sm text-slate-400">
                No pending requests. New requests from the welcome page show up here.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {requests.map((req) => (
                  <li key={req.id} className="px-4 py-4 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-white">{req.nurseryName}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {req.displayName} · {req.email}
                          {req.locale ? ` · ${req.locale}` : ''}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          {new Date(req.createdAt).toLocaleString()}
                        </p>
                        {req.message ? (
                          <p className="text-xs text-slate-300 mt-2 whitespace-pre-wrap">
                            {req.message}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={requestActionId === req.id}
                          onClick={() => openCreateFromRequest(req)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-ink-600 text-white hover:bg-ink-500 disabled:opacity-50"
                        >
                          Approve / create
                        </button>
                        <button
                          type="button"
                          disabled={requestActionId === req.id}
                          onClick={() => void handleDeclineRequest(req)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-slate-800 text-rose-300 hover:bg-slate-700 disabled:opacity-50"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {view === 'create' && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden max-w-2xl">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-emerald-300" />
              <h2 className="text-sm font-black text-white">
                {createRequestId ? 'Approve & create nursery' : 'Create nursery'}
              </h2>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-slate-400">
                Creates the workspace, owner login, and emails them a set-password link.
              </p>
              <label className="block text-xs space-y-1">
                <span className="font-bold text-slate-400">Owner name</span>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="block text-xs space-y-1">
                <span className="font-bold text-slate-400">Nursery name</span>
                <input
                  required
                  value={createNursery}
                  onChange={(e) => setCreateNursery(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="block text-xs space-y-1">
                <span className="font-bold text-slate-400">Owner email</span>
                <input
                  required
                  type="email"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Starting modules
                </p>
                <div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                  {TENANT_MODULE_DEFS.map((mod) => {
                    const on = createModules.includes(mod.id);
                    return (
                      <button
                        key={mod.id}
                        type="button"
                        onClick={() => toggleCreateModule(mod.id)}
                        className={`text-left rounded-lg border px-2.5 py-2 ${
                          on
                            ? 'border-ink-600/50 bg-ink-950/40'
                            : 'border-slate-700 bg-slate-950/40'
                        }`}
                      >
                        <span className="text-xs font-bold text-white">{mod.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  disabled={createBusy || !createNursery.trim() || !createEmail.trim()}
                  onClick={() => void handleProvisionNursery()}
                  className="px-4 py-2 rounded-xl text-xs font-black bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {createBusy ? 'Creating…' : 'Create nursery & email owner'}
                </button>
                <button
                  type="button"
                  disabled={createBusy}
                  onClick={() => {
                    resetCreateForm();
                    setView(createRequestId ? 'requests' : 'nurseries');
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 text-slate-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </section>
        )}

        {view === 'nurseries' && (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-6">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-ink-400" />
                <h2 className="text-sm font-black text-white">Nurseries ({tenants.length})</h2>
              </div>
              <button
                type="button"
                onClick={openBlankCreate}
                className="text-[11px] font-bold text-ink-300 hover:text-white"
              >
                + New
              </button>
            </div>
            {loading ? (
              <p className="p-4 text-sm text-slate-400">Loading…</p>
            ) : tenants.length === 0 ? (
              <p className="p-4 text-sm text-slate-400">No nurseries found yet.</p>
            ) : (
              <ul className="max-h-[560px] overflow-y-auto divide-y divide-slate-800">
                {tenants.map((t) => {
                  const active = t.id === selectedId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => selectTenant(t.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          active ? 'bg-ink-950/50' : 'hover:bg-slate-800/60'
                        }`}
                      >
                        <span className="block text-sm font-bold text-white">{t.name}</span>
                        <span className="block text-[10px] font-mono text-slate-500 mt-0.5 truncate">
                          {t.id}
                        </span>
                        <span className="block text-[11px] text-slate-400 mt-1">
                          {moduleSummary(t)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden flex flex-col min-h-[420px]">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <Package className="h-4 w-4 text-amber-300" />
              <h2 className="text-sm font-black text-white">
                {selected ? selected.name : 'Select a nursery'}
              </h2>
            </div>

            {!selected ? (
              <p className="p-4 text-sm text-slate-400">Pick a nursery on the left to edit its package.</p>
            ) : (
              <div className="p-4 space-y-4 flex-1 flex flex-col">
                <div className="rounded-xl border border-amber-900/40 bg-amber-950/30 px-3 py-2.5">
                  <p className="text-xs font-bold text-amber-200">Activation</p>
                  <p className="text-[11px] text-amber-200/70 mt-0.5">
                    New nurseries start with no workspaces. Toggle the modules below, then Save
                    package to activate them.
                  </p>
                </div>

                {legacyAllOn && (
                  <p className="text-[11px] text-amber-200 bg-amber-950/40 border border-amber-800/50 rounded-xl px-3 py-2">
                    Legacy plan (all standard modules). Saving will lock in the toggles below.
                  </p>
                )}

                <div className="space-y-2 flex-1">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Workspaces & modules
                  </p>
                  {TENANT_MODULE_DEFS.map((mod) => {
                    const on = draft.includes(mod.id);
                    return (
                      <button
                        key={mod.id}
                        type="button"
                        onClick={() => toggleModule(mod.id)}
                        className={`w-full text-left rounded-xl border px-3 py-3 flex items-start gap-3 transition-colors ${
                          on
                            ? 'border-ink-600/50 bg-ink-950/40'
                            : 'border-slate-700 bg-slate-950/40 hover:bg-slate-800/40'
                        }`}
                      >
                        <span
                          className={`mt-0.5 h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 ${
                            on ? 'bg-ink-600 border-ink-500 text-white' : 'border-slate-600'
                          }`}
                        >
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-white">{mod.label}</span>
                          <span className="block text-[11px] text-slate-400 mt-0.5">
                            {mod.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Ship-from / origin address
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Shown as the origin on invoices and bills of lading for this nursery.
                  </p>
                  <textarea
                    value={addressDraft}
                    onChange={(e) => setAddressDraft(e.target.value)}
                    rows={3}
                    placeholder={'11428 US 165\nForest Hill, LA'}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-ink-500 focus:outline-none resize-none"
                  />
                  <button
                    type="button"
                    disabled={savingAddress}
                    onClick={handleSaveAddress}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-black bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    {savingAddress ? 'Saving…' : 'Save address'}
                  </button>
                </div>

                <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Nursery logo / branding
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Appears on invoices and bills of lading. Upload an image or paste an HTTPS
                    image URL.
                  </p>
                  <div className="flex items-center gap-3">
                    <div className="h-16 w-16 rounded-xl border border-slate-700 bg-slate-900 flex items-center justify-center overflow-hidden shrink-0">
                      {logoPreviewSrc ? (
                        <img
                          src={logoPreviewSrc}
                          alt={`${selected?.name || 'Nursery'} logo preview`}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <ImagePlus className="h-6 w-6 text-slate-600" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-xs text-slate-300 font-semibold truncate">
                        {selected?.name}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {logoDraft.trim()
                          ? 'Custom logo set'
                          : logoPreviewSrc
                            ? 'Using built-in default logo'
                            : 'No logo yet'}
                      </p>
                    </div>
                  </div>
                  <input
                    ref={logoFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      void handleLogoFile(e.target.files?.[0] || null);
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={savingLogo}
                      onClick={() => logoFileRef.current?.click()}
                      className="px-4 py-2 rounded-lg text-xs font-black bg-ink-700 text-white hover:bg-ink-600 disabled:opacity-50"
                    >
                      {savingLogo ? 'Saving…' : 'Upload image'}
                    </button>
                    <button
                      type="button"
                      disabled={savingLogo || !logoDraft.trim()}
                      onClick={() => void handleClearLogo()}
                      className="px-4 py-2 rounded-lg text-xs font-black bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                    >
                      Clear logo
                    </button>
                  </div>
                  <input
                    type="url"
                    value={logoDraft.startsWith('data:') ? '' : logoDraft}
                    onChange={(e) => setLogoDraft(e.target.value)}
                    placeholder="https://example.com/logo.png"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-ink-500 focus:outline-none"
                  />
                  {logoDraft.startsWith('data:') && (
                    <p className="text-[11px] text-slate-500">
                      Uploaded image is stored on this nursery. Paste a URL above only if you want
                      to replace it with a hosted image.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={savingLogo || logoDraft.startsWith('data:')}
                    onClick={() => void handleSaveLogoUrl()}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-black bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    {savingLogo ? 'Saving…' : 'Save logo URL'}
                  </button>
                </div>

                <div className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-3 space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Owner login
                  </p>
                  <p className="text-[11px] text-slate-400">
                    If they never got the welcome email, resend a set-password link to the nursery
                    owner.
                  </p>
                  <button
                    type="button"
                    disabled={resendingPassword || deleting || saving}
                    onClick={() => void handleResendPassword()}
                    className="px-4 py-2 rounded-lg text-xs font-black bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    {resendingPassword ? 'Sending…' : 'Resend set-password email'}
                  </button>
                </div>

                {error && <p className="text-xs text-red-400 font-semibold">{error}</p>}
                {message && <p className="text-xs text-ink-300 font-semibold">{message}</p>}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    disabled={deleting || saving || resendingPassword}
                    onClick={() => void handleDeleteNursery()}
                    className="px-4 py-2.5 rounded-xl text-xs font-black border border-rose-800/60 bg-rose-950/40 text-rose-300 hover:bg-rose-900/50 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete nursery'}
                  </button>
                  <button
                    type="button"
                    disabled={saving || deleting || resendingPassword}
                    onClick={handleSave}
                    className="px-5 py-2.5 rounded-xl text-xs font-black bg-ink-600 text-white hover:bg-ink-500 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save package'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
        )}
      </main>
    </div>
  );
}
