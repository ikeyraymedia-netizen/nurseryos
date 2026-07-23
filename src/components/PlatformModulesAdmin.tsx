import { useEffect, useState } from 'react';
import { Package, X, Check } from 'lucide-react';
import { Tenant, TenantModuleId } from '../types';
import { listAllTenants, updateTenantModules } from '../lib/tenants';
import {
  TENANT_MODULE_DEFS,
  resolveEnabledModules
} from '../lib/modules';

interface PlatformModulesAdminProps {
  currentTenantId: string;
  onClose: () => void;
  onModulesUpdated?: (tenant: Tenant) => void;
}

export function PlatformModulesAdmin({
  currentTenantId,
  onClose,
  onModulesUpdated
}: PlatformModulesAdminProps) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedId, setSelectedId] = useState(currentTenantId);
  const [draft, setDraft] = useState<TenantModuleId[]>([]);
  const [legacyAllOn, setLegacyAllOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listAllTenants();
      setTenants(list);
      const selected = list.find((t) => t.id === selectedId) || list.find((t) => t.id === currentTenantId) || list[0];
      if (selected) {
        setSelectedId(selected.id);
        loadDraft(selected);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load nurseries. Publish Firestore rules and set isPlatformAdmin on your user.');
    } finally {
      setLoading(false);
    }
  }

  function loadDraft(tenant: Tenant) {
    if (tenant.modules == null) {
      setLegacyAllOn(true);
      setDraft([...resolveEnabledModules(tenant)]);
    } else {
      setLegacyAllOn(false);
      setDraft([...resolveEnabledModules(tenant)]);
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await updateTenantModules(selectedId, draft);
      const updated: Tenant = {
        ...(tenants.find((t) => t.id === selectedId) as Tenant),
        modules: [...draft]
      };
      setTenants((prev) => prev.map((t) => (t.id === selectedId ? updated : t)));
      setLegacyAllOn(false);
      setMessage('Modules saved.');
      onModulesUpdated?.(updated);
    } catch (err: any) {
      setError(err?.message || 'Failed to save modules.');
    } finally {
      setSaving(false);
    }
  }

  const selected = tenants.find((t) => t.id === selectedId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-900 text-white">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-emerald-300" />
            <div>
              <h2 className="text-base font-black">Nursery packages</h2>
              <p className="text-[11px] text-slate-300">Turn modules on/off per nursery (platform admin)</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {loading ? (
            <p className="text-sm text-slate-500">Loading nurseries…</p>
          ) : (
            <>
              <div>
                <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">Nursery</label>
                <select
                  value={selectedId}
                  onChange={(e) => selectTenant(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium"
                >
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.id === currentTenantId ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
                {selected && (
                  <p className="text-[11px] text-slate-500 mt-1 font-mono">{selected.id}</p>
                )}
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-xs font-bold text-amber-900">Activation</p>
                <p className="text-[11px] text-amber-800/80 mt-0.5">
                  New nurseries start with no workspaces. Toggle modules below, then save.
                </p>
              </div>

              {legacyAllOn && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  This nursery is on a legacy plan (all standard modules). Saving will lock in the
                  toggles below.
                </p>
              )}

              <div className="space-y-2">
                <p className="text-xs font-bold uppercase text-slate-500">Workspaces & modules</p>
                {TENANT_MODULE_DEFS.map((mod) => {
                  const on = draft.includes(mod.id);
                  return (
                    <button
                      key={mod.id}
                      type="button"
                      onClick={() => toggleModule(mod.id)}
                      className={`w-full text-left rounded-xl border px-3 py-3 flex items-start gap-3 transition-colors ${
                        on
                          ? 'border-emerald-300 bg-emerald-50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`mt-0.5 h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 ${
                          on ? 'bg-emerald-700 border-emerald-700 text-white' : 'border-slate-300'
                        }`}
                      >
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-gray-900">{mod.label}</span>
                        <span className="block text-[11px] text-slate-500 mt-0.5">{mod.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {error && <p className="text-xs text-red-600 font-semibold">{error}</p>}
              {message && <p className="text-xs text-emerald-800 font-semibold">{message}</p>}
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 bg-white"
          >
            Close
          </button>
          <button
            type="button"
            disabled={saving || loading || !selected}
            onClick={handleSave}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-700 text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save modules'}
          </button>
        </div>
      </div>
    </div>
  );
}
