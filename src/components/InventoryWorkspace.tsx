import { FormEvent, useEffect, useState } from 'react';
import { Sprout, Upload, Plus, Droplets, Scissors, Search, RefreshCw, AlertCircle } from 'lucide-react';
import { InventoryPlant } from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  addChemicalApplication,
  addInventoryPlant,
  bulkImportInventoryPlants,
  deleteAllInventoryPlants,
  deleteInventoryPlant,
  parseCsvInventory,
  subscribeToInventory,
  updateInventoryPlant
} from '../lib/inventory';

interface InventoryWorkspaceProps {
  permissions: AppPermissions;
}

const INVENTORY_UPLOAD_TIMEOUT_MS = 360_000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const INVENTORY_AI_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]);

function inferInventoryMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    default:
      return 'application/octet-stream';
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function InventoryWorkspace({ permissions }: InventoryWorkspaceProps) {
  const [plants, setPlants] = useState<InventoryPlant[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [newPlantName, setNewPlantName] = useState('');
  const [newContainerSize, setNewContainerSize] = useState('#3');
  const [newQty, setNewQty] = useState(0);
  const [newWeeks, setNewWeeks] = useState<number | ''>('');
  const [newLocation, setNewLocation] = useState('');

  const [chemName, setChemName] = useState('');
  const [chemDate, setChemDate] = useState(new Date().toISOString().split('T')[0]);
  const [chemNotes, setChemNotes] = useState('');

  useEffect(() => {
    return subscribeToInventory(setPlants);
  }, []);

  const selected = plants.find((p) => p.id === selectedId) || null;

  const filtered = plants.filter((p) => {
    const q = search.toLowerCase();
    return (
      p.plantName.toLowerCase().includes(q) ||
      p.containerSize.toLowerCase().includes(q) ||
      (p.location || '').toLowerCase().includes(q)
    );
  });

  async function handleAddPlant(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canEditInventory) return;
    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const id = await addInventoryPlant({
        plantName: newPlantName.trim(),
        containerSize: newContainerSize.trim(),
        quantityAvailable: newQty,
        weeksUntilReady: newWeeks === '' ? null : Number(newWeeks),
        chemicals: [],
        cutBackAt: null,
        location: newLocation.trim() || undefined,
        notes: ''
      });
      setSelectedId(id);
      setNewPlantName('');
      setNewQty(0);
      setNewWeeks('');
      setNewLocation('');
      setMessage('Plant added to live inventory.');
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to add plant.');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleCsvUpload(file: File) {
    if (!permissions.canUploadInventory) return;
    setUploadLoading(true);
    setUploadError(null);
    setUploadStatus('Reading CSV file...');
    setMessage(null);
    setMessageIsError(false);
    try {
      const text = await file.text();
      const parsed = parseCsvInventory(text);
      if (parsed.length === 0) {
        throw new Error('No rows found. CSV needs headers like plant, size, qty, weeks, location.');
      }
      setUploadStatus(`Saving ${parsed.length} plants to inventory...`);
      const count = await bulkImportInventoryPlants(parsed);
      setMessage(`Imported ${count} plants from CSV.`);
      setMessageIsError(false);
    } catch (err: any) {
      const msg = err?.message || 'CSV import failed.';
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
    } finally {
      setUploadLoading(false);
      setUploadStatus('');
    }
  }

  async function handleNonCsvUpload(file: File) {
    if (!permissions.canUploadInventory) return;

    const mimeType = inferInventoryMimeType(file);
    if (!INVENTORY_AI_MIME_TYPES.has(mimeType)) {
      const msg = 'Unsupported file format. Upload a PDF, photo (PNG/JPEG/WebP), or Excel spreadsheet.';
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      const msg = 'File is too large. Please upload a file under 20 MB.';
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
      return;
    }

    setUploadLoading(true);
    setUploadError(null);
    setUploadStatus('Reading file...');
    setMessage(null);
    setMessageIsError(false);

    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read the selected file.'));
        reader.readAsDataURL(file);
      });

      setUploadStatus('Analyzing inventory with AI (large PDFs may take 2–4 minutes)...');

      const waitStarted = Date.now();
      const waitTicker = window.setInterval(() => {
        const elapsedSec = Math.round((Date.now() - waitStarted) / 1000);
        setUploadStatus(`Still analyzing with AI… (${elapsedSec}s elapsed)`);
      }, 15_000);

      let response: Response;
      try {
        response = await fetchWithTimeout(
          '/api/parse-inventory',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              base64Data,
              mimeType,
              fileName: file.name
            })
          },
          INVENTORY_UPLOAD_TIMEOUT_MS
        );
      } finally {
        clearInterval(waitTicker);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const friendly =
          response.status === 503
            ? 'AI service is temporarily busy. Wait a few seconds and try again.'
            : errorData.error || errorData.details || 'AI inventory import failed.';
        throw new Error(friendly);
      }

      const result = await response.json();
      const rawItems = Array.isArray(result?.items) ? result.items : [];
      if (rawItems.length === 0) {
        throw new Error('No inventory plants were detected in this file.');
      }

      const normalized = rawItems.map((item: any) => {
        const chemicals = Array.isArray(item?.recentChemicals)
          ? item.recentChemicals
              .filter((c: any) => c?.chemicalName)
              .map((c: any) => {
                const entry: { chemicalName: string; appliedAt: string; notes?: string } = {
                  chemicalName: String(c.chemicalName),
                  appliedAt: c?.appliedAt ? String(c.appliedAt) : new Date().toISOString().split('T')[0]
                };
                if (c?.notes) entry.notes = String(c.notes);
                return entry;
              })
          : [];

        const entry: Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'> = {
          plantName: String(item?.plantName || 'Unknown Plant'),
          containerSize: String(item?.containerSize || 'Other'),
          quantityAvailable: Number(item?.quantityAvailable ?? 0) || 0,
          weeksUntilReady:
            item?.weeksUntilReady === null || item?.weeksUntilReady === undefined || item?.weeksUntilReady === ''
              ? null
              : Number(item.weeksUntilReady) || null,
          chemicals,
          cutBackAt: item?.cutBackAt ? String(item.cutBackAt) : null,
          notes: item?.notes ? String(item.notes) : ''
        };
        if (item?.location) entry.location = String(item.location);
        return entry;
      });

      setUploadStatus(`Saving ${normalized.length} plants to inventory...`);
      const count = await bulkImportInventoryPlants(normalized);
      setMessage(`Imported ${count} plants from ${file.name}.`);
      setMessageIsError(false);
    } catch (err: any) {
      console.error('Inventory upload failed:', err);
      const msg =
        err?.name === 'AbortError'
          ? 'Analysis timed out after several minutes. Try again and let it run, or export fewer pages from the PDF.'
          : err?.message || 'AI inventory import failed.';
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
    } finally {
      setUploadLoading(false);
      setUploadStatus('');
    }
  }

  async function saveSelected(updates: Partial<InventoryPlant>) {
    if (!selected || !permissions.canEditInventory) return;
    setBusy(true);
    try {
      await updateInventoryPlant({ ...selected, ...updates });
      setMessage('Inventory updated.');
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || 'Update failed.');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddChemical(e: FormEvent) {
    e.preventDefault();
    if (!selected || !permissions.canEditInventory || !chemName.trim()) return;
    setBusy(true);
    try {
      await addChemicalApplication(
        selected.id,
        { chemicalName: chemName.trim(), appliedAt: chemDate, notes: chemNotes.trim() || undefined },
        selected
      );
      setChemName('');
      setChemNotes('');
      setMessage('Chemical application recorded.');
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to record chemical.');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAllInventory() {
    if (!permissions.canEditInventory) return;
    if (plants.length === 0) {
      setMessage('Inventory is already empty.');
      setMessageIsError(false);
      return;
    }
    const ok = window.confirm(
      `Delete all ${plants.length} inventory items? This cannot be undone. Use this if you accidentally imported a customer list into inventory.`
    );
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const count = await deleteAllInventoryPlants();
      setSelectedId(null);
      setMessage(`Removed ${count} item${count === 1 ? '' : 's'} from inventory.`);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to clear inventory.');
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-emerald-100 p-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center">
            <Sprout className="h-5 w-5 text-emerald-700" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Live Plant Inventory</h2>
            <p className="text-xs text-gray-500">
              Track qty available, weeks until ready, chemical sprays, and cut-backs.
            </p>
          </div>
        </div>

        {permissions.canUploadInventory && (
          <div className="mt-4 space-y-3">
            {!uploadLoading ? (
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold cursor-pointer hover:bg-emerald-800">
                  <Upload className="h-4 w-4" />
                  Upload CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCsvUpload(file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer hover:bg-slate-200">
                  <Upload className="h-4 w-4" />
                  PDF / Photo / Excel
                  <input
                    type="file"
                    accept=".pdf,.xlsx,.xls,image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleNonCsvUpload(file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {permissions.canEditInventory && plants.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleClearAllInventory}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                  >
                    Clear all inventory
                  </button>
                )}
              </div>
            ) : (
              <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-4 flex items-center gap-3">
                <RefreshCw className="h-5 w-5 text-emerald-700 animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-gray-800">Processing inventory file</p>
                  <p className="text-xs text-gray-500 mt-0.5">{uploadStatus}</p>
                </div>
              </div>
            )}
            {uploadError && (
              <div className="bg-red-50 border border-red-100 rounded-xl p-3 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                <p className="text-xs text-red-800">{uploadError}</p>
              </div>
            )}
          </div>
        )}
        {message && (
          <p
            className={`mt-3 text-xs font-medium rounded-lg px-3 py-2 border ${
              messageIsError
                ? 'text-red-800 bg-red-50 border-red-100'
                : 'text-emerald-800 bg-emerald-50 border-emerald-100'
            }`}
          >
            {message}
          </p>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="relative">
            <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plants..."
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 text-sm"
            />
          </div>

          <div className="bg-white rounded-2xl border border-gray-150 max-h-[420px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">No inventory yet.</p>
            ) : (
              filtered.map((plant) => (
                <button
                  key={plant.id}
                  type="button"
                  onClick={() => setSelectedId(plant.id)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-emerald-50/50 ${
                    selectedId === plant.id ? 'bg-emerald-50' : ''
                  }`}
                >
                  <p className="font-bold text-sm text-gray-900">{plant.plantName}</p>
                  <p className="text-xs text-gray-500">
                    {plant.containerSize} • Qty {plant.quantityAvailable}
                    {plant.weeksUntilReady != null ? ` • ${plant.weeksUntilReady} wks` : ''}
                  </p>
                </button>
              ))
            )}
          </div>

          {permissions.canEditInventory && (
            <form onSubmit={handleAddPlant} className="bg-white rounded-2xl border border-gray-150 p-4 space-y-2">
              <p className="text-xs font-bold uppercase text-gray-500">Add plant manually</p>
              <input
                required
                value={newPlantName}
                onChange={(e) => setNewPlantName(e.target.value)}
                placeholder="Plant name"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={newContainerSize}
                  onChange={(e) => setNewContainerSize(e.target.value)}
                  placeholder="Size (#3)"
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  min={0}
                  value={newQty}
                  onChange={(e) => setNewQty(Number(e.target.value))}
                  placeholder="Qty"
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <input
                type="number"
                min={0}
                value={newWeeks}
                onChange={(e) => setNewWeeks(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Weeks until ready (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              <input
                value={newLocation}
                onChange={(e) => setNewLocation(e.target.value)}
                placeholder="Location (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 text-white text-xs font-bold py-2.5"
              >
                <Plus className="h-4 w-4" />
                Add to inventory
              </button>
            </form>
          )}
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <div className="bg-white rounded-2xl border border-gray-150 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-gray-900">{selected.plantName}</h3>
                  <p className="text-sm text-gray-500">{selected.containerSize}</p>
                </div>
                {permissions.canEditInventory && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm('Delete this plant from inventory?')) return;
                      await deleteInventoryPlant(selected.id);
                      setSelectedId(null);
                    }}
                    className="text-xs font-bold text-red-600 hover:text-red-700"
                  >
                    Delete
                  </button>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="font-bold text-gray-500 uppercase">Qty available</span>
                  <input
                    type="number"
                    min={0}
                    disabled={!permissions.canEditInventory}
                    value={selected.quantityAvailable}
                    onChange={(e) =>
                      saveSelected({ quantityAvailable: Number(e.target.value) || 0 })
                    }
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-gray-500 uppercase">Weeks until ready</span>
                  <input
                    type="number"
                    min={0}
                    disabled={!permissions.canEditInventory}
                    value={selected.weeksUntilReady ?? ''}
                    onChange={(e) =>
                      saveSelected({
                        weeksUntilReady: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div>
                <p className="text-xs font-bold uppercase text-gray-500 mb-2 flex items-center gap-1">
                  <Scissors className="h-3.5 w-3.5" /> Cut-back status
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="date"
                    disabled={!permissions.canEditInventory}
                    value={selected.cutBackAt?.split('T')[0] || ''}
                    onChange={(e) =>
                      saveSelected({ cutBackAt: e.target.value ? `${e.target.value}T00:00:00.000Z` : null })
                    }
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                  {permissions.canEditInventory && (
                    <button
                      type="button"
                      onClick={() =>
                        saveSelected({
                          cutBackAt: new Date().toISOString(),
                          cutBackNotes: 'Cut back recorded by field crew'
                        })
                      }
                      className="px-3 py-2 rounded-lg bg-amber-50 text-amber-800 text-xs font-bold border border-amber-200"
                    >
                      Mark cut back today
                    </button>
                  )}
                </div>
                {selected.cutBackNotes && (
                  <p className="text-xs text-gray-500 mt-2">{selected.cutBackNotes}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-bold uppercase text-gray-500 mb-2 flex items-center gap-1">
                  <Droplets className="h-3.5 w-3.5" /> Chemical spray history
                </p>
                <div className="space-y-2 mb-3">
                  {(selected.chemicals || []).length === 0 ? (
                    <p className="text-xs text-gray-400">No sprays recorded yet.</p>
                  ) : (
                    selected.chemicals.map((c, i) => (
                      <div key={i} className="text-xs bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                        <span className="font-bold text-gray-800">{c.chemicalName}</span>
                        <span className="text-gray-500"> • {c.appliedAt.split('T')[0]}</span>
                        {c.notes && <p className="text-gray-500 mt-0.5">{c.notes}</p>}
                      </div>
                    ))
                  )}
                </div>
                {permissions.canEditInventory && (
                  <form onSubmit={handleAddChemical} className="grid sm:grid-cols-3 gap-2">
                    <input
                      required
                      value={chemName}
                      onChange={(e) => setChemName(e.target.value)}
                      placeholder="Chemical name"
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <input
                      type="date"
                      value={chemDate}
                      onChange={(e) => setChemDate(e.target.value)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg bg-emerald-700 text-white text-xs font-bold"
                    >
                      Log spray
                    </button>
                  </form>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-12 text-center text-sm text-gray-500">
              Select a plant to view and update inventory details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
