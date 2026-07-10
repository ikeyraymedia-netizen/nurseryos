import { FormEvent, useState } from 'react';
import { AlertCircle, Plus, Sprout, X } from 'lucide-react';
import { ContainerWeight, InventoryPlant } from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  addInventoryPlant,
  InventoryMatchRequest,
  rememberInventoryAlias
} from '../lib/inventory';

interface InventoryMatchModalProps {
  request: InventoryMatchRequest;
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
  containerWeights,
  permissions,
  onResolve
}: InventoryMatchModalProps) {
  const [showCreateForm, setShowCreateForm] = useState(
    request.suggestions.length === 0 && permissions.canEditInventory
  );
  const [createPlantName, setCreatePlantName] = useState(request.plantName);
  const [createContainerSize, setCreateContainerSize] = useState(
    defaultContainerSize(request, containerWeights)
  );
  const [createQty, setCreateQty] = useState(request.quantityHint ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError('Plant name is required.');
      return;
    }
    if (!containerSize) {
      setError('Container size is required.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const id = await addInventoryPlant({
        plantName,
        containerSize,
        quantityAvailable: Math.max(0, createQty),
        weeksUntilReady: null,
        chemicals: [],
        cutBackAt: null,
        notes: ''
      });
      const created: InventoryPlant = {
        id,
        plantName,
        containerSize,
        quantityAvailable: Math.max(0, createQty),
        weeksUntilReady: null,
        chemicals: [],
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
      setError(err?.message || 'Failed to create inventory item.');
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
                Match to inventory
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                No exact match found — link this line to inventory.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onResolve(null)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-gray-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
            <span className="font-semibold text-gray-800">Order line:</span>{' '}
            {request.plantName}
            <span className="text-gray-400"> • {request.containerSize}</span>
            {request.quantityHint != null && request.quantityHint > 0 && (
              <span className="text-gray-400"> • Qty {request.quantityHint}</span>
            )}
          </div>

          {request.suggestions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Click a suggestion to link
              </p>
              {request.suggestions.map(({ plant, score }) => (
                <button
                  key={plant.id}
                  type="button"
                  disabled={busy}
                  onClick={() => pickSuggestion(plant)}
                  className="w-full text-left px-3 py-3 rounded-lg border-2 border-gray-200 bg-white hover:border-emerald-400 hover:bg-emerald-50 text-sm disabled:opacity-50 touch-manipulation active:scale-[0.99] transition-all"
                >
                  <span className="font-bold text-gray-900">{plant.plantName}</span>
                  <span className="text-gray-500"> • {plant.containerSize}</span>
                  <span className="text-gray-400"> • Qty {plant.quantityAvailable}</span>
                  {score < 1 && (
                    <span className="ml-1 text-[10px] text-amber-600 font-semibold">
                      ({Math.round(score * 100)}% match)
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {request.suggestions.length === 0 && permissions.canEditInventory && !showCreateForm && (
            <p className="text-xs text-gray-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
              No similar inventory items found. Create a new product below to link this line.
            </p>
          )}

          {permissions.canEditInventory && (
            <div className="space-y-2">
              {!showCreateForm ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowCreateForm(true)}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 rounded-lg border-2 border-dashed border-emerald-400 bg-emerald-50/50 text-emerald-900 text-sm font-bold hover:bg-emerald-50 disabled:opacity-50 touch-manipulation"
                >
                  <Plus className="h-4 w-4" />
                  Create new and link
                </button>
              ) : (
                <form
                  onSubmit={handleCreateSubmit}
                  className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/30 space-y-2"
                >
                  <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
                    Create new inventory item
                  </p>
                  <input
                    required
                    value={createPlantName}
                    onChange={(e) => setCreatePlantName(e.target.value)}
                    placeholder="Plant name"
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
                      placeholder="Container size"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                    />
                  )}
                  <input
                    type="number"
                    min={0}
                    value={createQty}
                    onChange={(e) => setCreateQty(Number(e.target.value))}
                    placeholder="Qty on hand"
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
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="flex-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold disabled:opacity-50"
                    >
                      {busy ? 'Creating…' : 'Create new and link'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {!permissions.canEditInventory && request.suggestions.length === 0 && (
            <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              No similar inventory items found. Ask someone with inventory access to add this
              product.
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
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
