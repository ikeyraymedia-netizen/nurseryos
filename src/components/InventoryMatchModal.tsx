import { FormEvent, useMemo, useState } from 'react';
import { AlertCircle, Plus, Search, Sprout, X } from 'lucide-react';
import { ContainerWeight, InventoryPlant } from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  addInventoryPlant,
  InventoryMatchRequest,
  rememberInventoryAlias
} from '../lib/inventory';
import { useT } from '../lib/i18n';

interface InventoryMatchModalProps {
  request: InventoryMatchRequest;
  inventoryPlants: InventoryPlant[];
  containerWeights: ContainerWeight[];
  permissions: AppPermissions;
  onResolve: (plants: InventoryPlant[] | null) => void;
}

function defaultContainerSize(request: InventoryMatchRequest, weights: ContainerWeight[]): string {
  const match = weights.find(
    (w) =>
      w.id.toLowerCase() === request.containerSize.toLowerCase() ||
      w.label.toLowerCase() === request.containerSize.toLowerCase()
  );
  return match?.id || request.containerSize || weights[0]?.id || '#3';
}

export function InventoryMatchModal({
  request,
  inventoryPlants,
  containerWeights,
  permissions,
  onResolve
}: InventoryMatchModalProps) {
  const t = useT();
  const [showCreateForm, setShowCreateForm] = useState(
    request.suggestions.length === 0 && permissions.canEditInventory
  );
  const [showSearch, setShowSearch] = useState(request.suggestions.length === 0);
  const [searchQuery, setSearchQuery] = useState(request.plantName || '');
  const [createPlantName, setCreatePlantName] = useState(request.plantName);
  const [createContainerSize, setCreateContainerSize] = useState(
    defaultContainerSize(request, containerWeights)
  );
  const [createQty, setCreateQty] = useState(request.quantityHint ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchResults = useMemo(() => {
    if (!showSearch) return [];
    const q = searchQuery.trim().toLowerCase();
    const sorted = [...inventoryPlants].sort((a, b) =>
      a.plantName.localeCompare(b.plantName, undefined, { sensitivity: 'base' })
    );
    if (!q) return sorted.slice(0, 40);
    return sorted
      .filter((plant) => {
        const hay = [
          plant.plantName,
          plant.containerSize,
          plant.category || '',
          plant.location || '',
          plant.notes || ''
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q) || q.split(/\s+/).every((part) => hay.includes(part));
      })
      .slice(0, 40);
  }, [showSearch, searchQuery, inventoryPlants]);

  function pickSuggestion(plant: InventoryPlant) {
    rememberInventoryAlias(
      request.tenantId,
      request.plantName,
      request.containerSize,
      plant.plantName,
      plant.containerSize
    );
    onResolve([plant]);
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canEditInventory) return;

    const plantName = createPlantName.trim();
    const containerSize = createContainerSize.trim();
    if (!plantName) {
      setError(t('match.nameRequired'));
      return;
    }
    if (!containerSize) {
      setError(t('match.sizeRequired'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const id = await addInventoryPlant({
        plantName,
        containerSize,
        quantityAvailable: Math.max(0, createQty),
        chemicals: [],
        fertilizers: [],
        cutBackAt: null,
        notes: ''
      });
      const created: InventoryPlant = {
        id,
        plantName,
        containerSize,
        quantityAvailable: Math.max(0, createQty),
        chemicals: [],
        fertilizers: [],
        cutBackAt: null,
        notes: '',
        dateCreated: new Date().toISOString(),
        dateUpdated: new Date().toISOString()
      };
      rememberInventoryAlias(
        request.tenantId,
        request.plantName,
        request.containerSize,
        plantName,
        containerSize
      );
      onResolve([created]);
    } catch (err: any) {
      setError(err?.message || t('match.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-match-title"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
              <Sprout className="h-5 w-5 text-amber-700" />
            </div>
            <div>
              <h2 id="inventory-match-title" className="text-base font-bold text-gray-900">
                {t('match.title')}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">{t('match.noExact')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onResolve(null)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-gray-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
            <span className="font-semibold text-gray-800">{t('match.orderLine')}</span>{' '}
            {request.plantName}
            <span className="text-gray-400"> • {request.containerSize}</span>
            {request.quantityHint != null && request.quantityHint > 0 && (
              <span className="text-gray-400">
                {' '}
                • {t('match.qtyLabel', { n: request.quantityHint })}
              </span>
            )}
          </div>

          {request.suggestions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                {t('match.clickSuggestion')}
              </p>
              {request.suggestions.map(({ plant, score }) => (
                <button
                  key={plant.id}
                  type="button"
                  disabled={busy}
                  onClick={() => pickSuggestion(plant)}
                  className="w-full text-left px-3 py-3 rounded-lg border-2 border-gray-200 bg-white hover:border-ink-400 hover:bg-ink-50 text-sm disabled:opacity-50 touch-manipulation active:scale-[0.99] transition-all"
                >
                  <span className="font-bold text-gray-900">{plant.plantName}</span>
                  <span className="text-gray-500"> • {plant.containerSize}</span>
                  <span className="text-gray-400">
                    {' '}
                    • {t('match.qtyLabel', { n: plant.quantityAvailable })}
                  </span>
                  {score < 1 && (
                    <span className="ml-1 text-[10px] text-amber-600 font-semibold">
                      {t('match.matchPct', { n: Math.round(score * 100) })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {!showSearch ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setShowSearch(true);
                  setShowCreateForm(false);
                  setSearchQuery(request.plantName || '');
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 rounded-lg border-2 border-ink-200 bg-white text-ink-900 text-sm font-bold hover:bg-ink-50 disabled:opacity-50 touch-manipulation"
              >
                <Search className="h-4 w-4" />
                {t('match.searchLink')}
              </button>
            ) : (
              <div className="border border-ink-200 rounded-xl p-3 bg-ink-50/30 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-ink-800">
                    {t('match.searchAll')}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowSearch(false)}
                    className="text-[11px] font-bold text-slate-500"
                  >
                    {t('match.hide')}
                  </button>
                </div>
                <div className="relative">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-gray-400" />
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('match.searchPlaceholder')}
                    className="w-full pl-8 pr-2 py-2 rounded-lg border border-gray-200 text-sm bg-white"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {inventoryPlants.length === 0 ? (
                    <p className="text-xs text-amber-800 py-2">{t('match.noPlantsLoaded')}</p>
                  ) : searchResults.length === 0 ? (
                    <p className="text-xs text-slate-500 py-2">
                      {t('match.noMatch', { query: searchQuery.trim() })}
                    </p>
                  ) : (
                    searchResults.map((plant) => (
                      <button
                        key={plant.id}
                        type="button"
                        disabled={busy}
                        onClick={() => pickSuggestion(plant)}
                        className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 bg-white hover:border-ink-400 hover:bg-ink-50 text-sm disabled:opacity-50"
                      >
                        <span className="font-bold text-gray-900">{plant.plantName}</span>
                        <span className="text-gray-500"> • {plant.containerSize}</span>
                        <span className="text-gray-400">
                          {' '}
                          • {t('match.qtyLabel', { n: plant.quantityAvailable })}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {permissions.canEditInventory && (
            <div className="space-y-2">
              {!showCreateForm ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setShowCreateForm(true);
                    setShowSearch(false);
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 rounded-lg border-2 border-dashed border-ink-400 bg-ink-50/50 text-ink-900 text-sm font-bold hover:bg-ink-50 disabled:opacity-50 touch-manipulation"
                >
                  <Plus className="h-4 w-4" />
                  {t('match.createAndLink')}
                </button>
              ) : (
                <form
                  onSubmit={handleCreateSubmit}
                  className="border border-ink-200 rounded-xl p-3 bg-ink-50/30 space-y-2"
                >
                  <p className="text-[11px] font-bold uppercase tracking-wide text-ink-800">
                    {t('match.createNew')}
                  </p>
                  <input
                    required
                    value={createPlantName}
                    onChange={(e) => setCreatePlantName(e.target.value)}
                    placeholder={t('inventory.plantName')}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                  />
                  {containerWeights.length > 0 ? (
                    <select
                      value={createContainerSize}
                      onChange={(e) => setCreateContainerSize(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                    >
                      {containerWeights.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      required
                      value={createContainerSize}
                      onChange={(e) => setCreateContainerSize(e.target.value)}
                      placeholder={t('match.containerSize')}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                    />
                  )}
                  <input
                    type="number"
                    min={0}
                    value={createQty || ''}
                    onChange={(e) => setCreateQty(Number(e.target.value) || 0)}
                    placeholder={t('match.qtyOnHand')}
                    onFocus={(e) => e.target.select()}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                  />
                  {error && (
                    <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      {error}
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setShowCreateForm(false);
                        setError(null);
                      }}
                      className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {t('common.back')}
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="flex-1 px-3 py-2 rounded-lg bg-ink-700 hover:bg-ink-800 text-white text-xs font-bold disabled:opacity-50"
                    >
                      {busy ? t('match.creating') : t('match.createAndLink')}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {!permissions.canEditInventory && request.suggestions.length === 0 && (
            <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              {t('match.noSimilar')}
            </p>
          )}
        </div>

        <div className="flex gap-2 p-5 border-t border-gray-100">
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(null)}
            className="flex-1 px-3 py-2.5 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {t('match.skip')}
          </button>
        </div>
      </div>
    </div>
  );
}
