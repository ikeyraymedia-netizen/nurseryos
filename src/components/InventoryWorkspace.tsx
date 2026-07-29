import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Sprout,
  Upload,
  Plus,
  Droplets,
  Leaf,
  Scissors,
  Search,
  RefreshCw,
  AlertCircle,
  Truck,
  Camera,
  FileSpreadsheet,
  FileText,
  ImageIcon
} from 'lucide-react';
import { CustomerOrder, InventoryPlant, Truck as TruckType } from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  addChemicalApplication,
  addFertilizerApplication,
  addInventoryPlant,
  bulkImportInventoryPlants,
  deleteAllInventoryPlants,
  deleteInventoryPlant,
  parseCsvInventory,
  parseExcelInventory,
  subscribeToInventory,
  updateInventoryPlant
} from '../lib/inventory';
import { buildLowStockForUpcomingTrucks } from '../lib/lowStockAlerts';
import {
  exportAvailabilityExcel,
  exportAvailabilityPdf,
  removeInventoryPlantPhoto,
  uploadInventoryPlantPhoto
} from '../lib/inventoryPhotos';
import { PdfShareSheet } from './PdfShareSheet';
import { useT } from '../lib/i18n';
import { usePlantDisplay } from '../lib/usePlantDisplay';

interface InventoryWorkspaceProps {
  permissions: AppPermissions;
  trucks?: TruckType[];
  orders?: CustomerOrder[];
  tenantId?: string;
  nurseryName?: string;
}

const LOW_STOCK_TOGGLE_KEY = 'nurseryos:inventory:showLowStockUpcoming';
const INVENTORY_UPLOAD_TIMEOUT_MS = 360_000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const INVENTORY_AI_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

function isSpreadsheetFile(file: File, mimeType: string): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.csv') ||
    name.endsWith('.tsv') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    mimeType === 'text/csv' ||
    mimeType === 'text/tab-separated-values' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

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
    case 'csv':
      return 'text/csv';
    case 'tsv':
      return 'text/tab-separated-values';
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

export function InventoryWorkspace({
  permissions,
  trucks = [],
  orders = [],
  tenantId,
  nurseryName = 'Nursery'
}: InventoryWorkspaceProps) {
  const t = useT();
  const dp = usePlantDisplay();
  const [plants, setPlants] = useState<InventoryPlant[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportInStockOnly, setExportInStockOnly] = useState(true);
  const [pdfSheet, setPdfSheet] = useState<{
    url: string;
    fileName: string;
    blob: Blob;
  } | null>(null);
  const [showLowStockUpcoming, setShowLowStockUpcoming] = useState(() => {
    try {
      return localStorage.getItem(LOW_STOCK_TOGGLE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [newPlantName, setNewPlantName] = useState('');
  const [newContainerSize, setNewContainerSize] = useState('#3');
  const [newQty, setNewQty] = useState(0);
  const [newWeeks, setNewWeeks] = useState<number | ''>('');
  const [newLocation, setNewLocation] = useState('');
  const [showAddPlant, setShowAddPlant] = useState(false);

  const [chemName, setChemName] = useState('');
  const [chemDate, setChemDate] = useState(new Date().toISOString().split('T')[0]);
  const [chemNotes, setChemNotes] = useState('');

  const [fertName, setFertName] = useState('');
  const [fertDate, setFertDate] = useState(new Date().toISOString().split('T')[0]);
  const [fertNotes, setFertNotes] = useState('');

  useEffect(() => {
    return subscribeToInventory(setPlants);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LOW_STOCK_TOGGLE_KEY, showLowStockUpcoming ? '1' : '0');
    } catch {
      // ignore
    }
  }, [showLowStockUpcoming]);

  const selected = plants.find((p) => p.id === selectedId) || null;

  const lowStockAlerts = useMemo(() => {
    if (!showLowStockUpcoming) return [];
    return buildLowStockForUpcomingTrucks({
      trucks,
      orders,
      inventory: plants,
      horizonDays: 14
    });
  }, [showLowStockUpcoming, trucks, orders, plants]);

  const filtered = plants.filter((p) => {
    const q = search.toLowerCase();
    return (
      p.plantName.toLowerCase().includes(q) ||
      p.containerSize.toLowerCase().includes(q) ||
      (p.location || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.listPrice != null && String(p.listPrice).includes(q))
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) => {
    const cat = (a.category || 'ZZZ').localeCompare(b.category || 'ZZZ');
    if (cat !== 0) return cat;
    const name = a.plantName.localeCompare(b.plantName);
    if (name !== 0) return name;
    return a.containerSize.localeCompare(b.containerSize);
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
        fertilizers: [],
        cutBackAt: null,
        location: newLocation.trim() || undefined,
        notes: ''
      });
      setSelectedId(id);
      setNewPlantName('');
      setNewQty(0);
      setNewWeeks('');
      setNewLocation('');
      setMessage(t('inventory.added'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.addFailed'));
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSpreadsheetUpload(file: File) {
    if (!permissions.canUploadInventory) return;
    setUploadLoading(true);
    setUploadError(null);
    setMessage(null);
    setMessageIsError(false);

    const lower = file.name.toLowerCase();
    const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');

    try {
      setUploadStatus(isExcel ? t('inventory.readingExcel') : t('inventory.readingCsv'));
      const parsed = isExcel
        ? await parseExcelInventory(file)
        : parseCsvInventory(await file.text());

      if (parsed.length === 0) {
        throw new Error(t('inventory.noPlantRows'));
      }

      setUploadStatus(t('inventory.savingPlants', { n: parsed.length }));
      const count = await bulkImportInventoryPlants(parsed);
      const zeroQty = parsed.filter((p) => !p.quantityAvailable).length;
      const withPrice = parsed.filter((p) => p.listPrice != null).length;
      setMessage(
        zeroQty > count * 0.8
          ? t('inventory.importedWithPrice', {
              count,
              withPrice,
              file: file.name
            })
          : t('inventory.importedFrom', { count, file: file.name })
      );
      setMessageIsError(false);
    } catch (err: any) {
      const msg = err?.message || t('inventory.spreadsheetImportFailed');
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
    if (isSpreadsheetFile(file, mimeType)) {
      await handleSpreadsheetUpload(file);
      return;
    }

    if (!INVENTORY_AI_MIME_TYPES.has(mimeType)) {
      const msg = t('inventory.unsupportedFormat');
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      const msg = t('inventory.fileTooLarge');
      setUploadError(msg);
      setMessage(msg);
      setMessageIsError(true);
      return;
    }

    setUploadLoading(true);
    setUploadError(null);
    setUploadStatus(t('inventory.readingFile'));
    setMessage(null);
    setMessageIsError(false);

    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(t('inventory.couldNotReadFile')));
        reader.readAsDataURL(file);
      });

      setUploadStatus(t('inventory.analyzingAi'));

      const waitStarted = Date.now();
      const waitTicker = window.setInterval(() => {
        const elapsedSec = Math.round((Date.now() - waitStarted) / 1000);
        setUploadStatus(t('inventory.stillAnalyzing', { elapsed: elapsedSec }));
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
            ? t('inventory.aiBusy')
            : errorData.error ||
              (typeof errorData.details === 'string' ? errorData.details : null) ||
              t('inventory.aiImportFailed');
        throw new Error(friendly);
      }

      const result = await response.json();
      const rawItems = Array.isArray(result?.items) ? result.items : [];
      if (rawItems.length === 0) {
        throw new Error(t('inventory.noPlantsDetected'));
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

      setUploadStatus(t('inventory.savingPlants', { n: normalized.length }));
      const count = await bulkImportInventoryPlants(normalized);
      setMessage(t('inventory.importedFrom', { count, file: file.name }));
      setMessageIsError(false);
    } catch (err: any) {
      console.error('Inventory upload failed:', err);
      const msg =
        err?.name === 'AbortError'
          ? t('inventory.analysisTimeout')
          : err?.message || t('inventory.aiImportFailed');
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
      setMessage(t('inventory.updated'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.updateFailed'));
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handlePhotoUpload(file: File) {
    if (!selected || !permissions.canEditInventory || !tenantId) {
      setMessage(t('inventory.signInForPhotos'));
      setMessageIsError(true);
      return;
    }
    setPhotoBusy(true);
    try {
      await uploadInventoryPlantPhoto({ tenantId, plant: selected, file });
      setMessage(t('inventory.photoSaved'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.photoUploadFailed'));
      setMessageIsError(true);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handlePhotoRemove() {
    if (!selected || !permissions.canEditInventory) return;
    if (!confirm(t('inventory.removePhotoConfirm'))) return;
    setPhotoBusy(true);
    try {
      await removeInventoryPlantPhoto(selected);
      setMessage(t('inventory.photoRemoved'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.couldNotRemovePhoto'));
      setMessageIsError(true);
    } finally {
      setPhotoBusy(false);
    }
  }

  const exportPlants = useMemo(() => {
    const list = exportInStockOnly
      ? plants.filter((p) => (p.quantityAvailable || 0) > 0)
      : plants;
    return [...list].sort((a, b) => a.plantName.localeCompare(b.plantName));
  }, [plants, exportInStockOnly]);

  async function handleExportExcel() {
    setExportBusy(true);
    try {
      await exportAvailabilityExcel({
        nurseryName,
        plants: exportPlants,
        inStockOnly: false
      });
      setMessage(t('inventory.exportedExcel', { n: exportPlants.length }));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.excelExportFailed'));
      setMessageIsError(true);
    } finally {
      setExportBusy(false);
    }
  }

  async function handleExportPdf() {
    setExportBusy(true);
    try {
      const result = await exportAvailabilityPdf({
        nurseryName,
        plants: exportPlants,
        inStockOnly: false
      });
      if (result.method === 'preview') {
        setPdfSheet({ url: result.url, fileName: result.fileName, blob: result.blob });
      } else {
        setMessage(t('inventory.exportedPdf', { n: exportPlants.length }));
        setMessageIsError(false);
      }
    } catch (err: any) {
      setMessage(err?.message || t('inventory.pdfExportFailed'));
      setMessageIsError(true);
    } finally {
      setExportBusy(false);
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
      setMessage(t('inventory.chemicalRecorded'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.chemicalFailed'));
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddFertilizer(e: FormEvent) {
    e.preventDefault();
    if (!selected || !permissions.canEditInventory || !fertName.trim()) return;
    setBusy(true);
    try {
      await addFertilizerApplication(
        selected.id,
        {
          fertilizerName: fertName.trim(),
          appliedAt: fertDate,
          notes: fertNotes.trim() || undefined
        },
        selected
      );
      setFertName('');
      setFertNotes('');
      setMessage(t('inventory.fertilizerRecorded'));
      setMessageIsError(false);
    } catch (err: any) {
      setMessage(err?.message || t('inventory.fertilizerFailed'));
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAllInventory() {
    if (!permissions.canEditInventory) return;
    if (plants.length === 0) {
      setMessage(t('inventory.inventoryEmpty'));
      setMessageIsError(false);
      return;
    }
    const ok = window.confirm(t('inventory.clearAllConfirm', { n: plants.length }));
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const count = await deleteAllInventoryPlants();
      setSelectedId(null);
      setMessage(t('inventory.removedItems', { n: count }));
    } catch (err: any) {
      setMessage(err?.message || t('inventory.clearInventoryFailed'));
      setMessageIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-ink-100 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-ink-50 flex items-center justify-center">
              <Sprout className="h-5 w-5 text-ink-700" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{t('inventory.title')}</h2>
              <p className="text-xs text-gray-500">{t('inventory.subtitle')}</p>
            </div>
          </div>
          <div className="flex flex-col items-stretch sm:items-end gap-2">
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                disabled={exportBusy || exportPlants.length === 0}
                onClick={() => void handleExportExcel()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-ink-200 bg-ink-50 text-ink-800 text-xs font-bold hover:bg-ink-100 disabled:opacity-50"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                {t('inventory.exportExcel')}
              </button>
              <button
                type="button"
                disabled={exportBusy || exportPlants.length === 0}
                onClick={() => void handleExportPdf()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                {t('inventory.exportPdf')}
              </button>
            </div>
            <label className="inline-flex items-center gap-2 text-[11px] font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={exportInStockOnly}
                onChange={(e) => setExportInStockOnly(e.target.checked)}
              />
              {t('inventory.inStockOnly', { n: exportPlants.length })}
            </label>
          </div>
        </div>

        {(permissions.canUploadInventory || permissions.canEditInventory) && (
          <div className="mt-4 space-y-3">
            {!uploadLoading ? (
              <div className="flex flex-wrap gap-2">
                {permissions.canUploadInventory && (
                  <>
                    <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold cursor-pointer hover:bg-ink-800">
                      <Upload className="h-4 w-4" />
                      {t('inventory.uploadCsvExcel')}
                      <input
                        type="file"
                        accept=".csv,.tsv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleSpreadsheetUpload(file);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                    <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold cursor-pointer hover:bg-slate-200">
                      <Upload className="h-4 w-4" />
                      {t('inventory.uploadPdfPhoto')}
                      <input
                        type="file"
                        accept=".pdf,image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleNonCsvUpload(file);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </>
                )}
                {permissions.canEditInventory && (
                  <button
                    type="button"
                    onClick={() => setShowAddPlant((v) => !v)}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold ${
                      showAddPlant
                        ? 'bg-ink-100 text-ink-900 border border-ink-300'
                        : 'bg-white text-ink-800 border border-ink-300 hover:bg-ink-50'
                    }`}
                  >
                    <Plus className="h-4 w-4" />
                    {t('inventory.addManually')}
                  </button>
                )}
                {permissions.canEditInventory && plants.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleClearAllInventory}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                  >
                    {t('inventory.clearAll')}
                  </button>
                )}
              </div>
            ) : (
              <div className="bg-ink-50/50 border border-ink-100 rounded-xl p-4 flex items-center gap-3">
                <RefreshCw className="h-5 w-5 text-ink-700 animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-gray-800">{t('inventory.processing')}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{uploadStatus}</p>
                </div>
              </div>
            )}
            {permissions.canEditInventory && showAddPlant && (
              <form
                onSubmit={handleAddPlant}
                className="bg-ink-50/40 border border-ink-200 rounded-xl p-4 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold uppercase text-ink-900">{t('inventory.addManually')}</p>
                  <button
                    type="button"
                    onClick={() => setShowAddPlant(false)}
                    className="text-[11px] font-bold text-ink-800 hover:underline"
                  >
                    {t('common.close')}
                  </button>
                </div>
                <input
                  required
                  value={newPlantName}
                  onChange={(e) => setNewPlantName(e.target.value)}
                  placeholder={t('inventory.plantName')}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={newContainerSize}
                    onChange={(e) => setNewContainerSize(e.target.value)}
                    placeholder={t('inventory.size')}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                  />
                  <input
                    type="number"
                    min={0}
                    value={newQty}
                    onChange={(e) => setNewQty(Number(e.target.value))}
                    placeholder={t('inventory.qty')}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                  />
                </div>
                <input
                  type="number"
                  min={0}
                  value={newWeeks}
                  onChange={(e) => setNewWeeks(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder={t('inventory.weeksReady')}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                />
                <input
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                  placeholder={t('inventory.location')}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-ink-700 text-white text-xs font-bold px-4 py-2.5 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {t('inventory.addToInventory')}
                </button>
              </form>
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
                : 'text-ink-800 bg-ink-50 border-ink-100'
            }`}
          >
            {message}
          </p>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Truck className="h-4 w-4 text-ink-700" />
            {t('inventory.lowStock')}
          </p>
          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{t('inventory.lowStockHint')}</p>
        </div>
        <label className="inline-flex items-center gap-2 shrink-0 cursor-pointer select-none">
          <span className="text-xs font-bold text-slate-600">{showLowStockUpcoming ? t('inventory.on') : t('inventory.off')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={showLowStockUpcoming}
            onClick={() => setShowLowStockUpcoming((v) => !v)}
            className={`relative h-7 w-12 rounded-full transition-colors ${
              showLowStockUpcoming ? 'bg-ink-700' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                showLowStockUpcoming ? 'left-5' : 'left-0.5'
              }`}
            />
          </button>
        </label>
      </div>

      {showLowStockUpcoming && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-xs font-black uppercase tracking-wide text-amber-900 mb-2">
            {t('inventory.shortages', { n: lowStockAlerts.length })}
          </p>
          {lowStockAlerts.length === 0 ? (
            <p className="text-sm text-amber-900/80">{t('inventory.noShortages')}</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {lowStockAlerts.map((alert) => (
                <div
                  key={`${alert.plantName}-${alert.containerSize}`}
                  className="bg-white border border-amber-200 rounded-xl px-3 py-2.5"
                >
                  <p className="text-sm font-bold text-gray-900">
                    {dp.plant(alert.plantName)}{' '}
                    <span className="text-xs font-mono text-slate-500">({dp.size(alert.containerSize)})</span>
                  </p>
                  <p className="text-xs text-amber-950 mt-0.5">
                    {t('inventory.need')} <span className="font-black">{alert.needed}</span> · {t('inventory.onHand')}{' '}
                    <span className="font-black">{alert.available}</span> · {t('inventory.short')}{' '}
                    <span className="font-black text-red-700">{alert.shortfall}</span>
                  </p>
                  <p className="text-[10px] text-slate-500 mt-1 truncate">
                    {alert.loadingDates.join(', ')} · {alert.truckNames.join(', ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="relative">
            <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('inventory.searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 text-sm"
            />
          </div>

          <div className="bg-white rounded-2xl border border-gray-150 max-h-[420px] overflow-y-auto">
            {sortedFiltered.length === 0 ? (
              <p className="p-4 text-sm text-gray-500">{t('inventory.noInventory')}</p>
            ) : (
              sortedFiltered.map((plant) => (
                <button
                  key={plant.id}
                  type="button"
                  onClick={() => setSelectedId(plant.id)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-ink-50/50 ${
                    selectedId === plant.id ? 'bg-ink-50' : ''
                  }`}
                >
                  <p className="font-bold text-sm text-gray-900 flex items-center gap-1.5">
                    {plant.photoUrl ? (
                      <ImageIcon className="h-3.5 w-3.5 text-ink-600 shrink-0" />
                    ) : null}
                    {dp.plant(plant.plantName)}
                  </p>
                  <p className="text-xs text-gray-500">
                    {plant.category ? `${plant.category} · ` : ''}
                    {dp.size(plant.containerSize)}
                    {plant.listPrice != null ? ` · $${plant.listPrice.toFixed(2)}` : ''}
                    {` · ${t('common.qty')} ${plant.quantityAvailable}`}
                    {plant.weeksUntilReady != null ? ` · ${plant.weeksUntilReady} ${t('inventory.weeks')}` : ''}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <div className="bg-white rounded-2xl border border-gray-150 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                <h3 className="text-xl font-black text-gray-900">{dp.plant(selected.plantName)}</h3>
                <p className="text-sm text-gray-500">
                  {selected.category ? `${selected.category} · ` : ''}
                  {dp.size(selected.containerSize)}
                  {selected.listPrice != null ? ` · $${selected.listPrice.toFixed(2)}` : ''}
                </p>
              </div>
                {permissions.canEditInventory && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(t('inventory.deleteConfirm'))) return;
                      await deleteInventoryPlant(selected.id);
                      setSelectedId(null);
                    }}
                    className="text-xs font-bold text-red-600 hover:text-red-700"
                  >
                    {t('common.delete')}
                  </button>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
                <p className="text-xs font-bold uppercase text-gray-500 flex items-center gap-1">
                  <Camera className="h-3.5 w-3.5" /> {t('inventory.plantPhoto')}
                </p>
                {selected.photoUrl ? (
                  <a
                    href={selected.photoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <img
                      src={selected.photoUrl}
                      alt={dp.plant(selected.plantName)}
                      className="h-40 w-full object-cover rounded-lg border border-slate-200 bg-white"
                    />
                  </a>
                ) : (
                  <div className="h-28 rounded-lg border border-dashed border-slate-300 bg-white flex items-center justify-center text-xs text-slate-400">
                    {t('inventory.noPhoto')}
                  </div>
                )}
                {permissions.canEditInventory && (
                  <div className="flex flex-wrap gap-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-700 text-white text-[11px] font-bold cursor-pointer hover:bg-ink-800 disabled:opacity-50">
                      {photoBusy
                        ? t('inventory.uploading')
                        : selected.photoUrl
                          ? t('inventory.replacePhoto')
                          : t('inventory.uploadPhotoBtn')}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={photoBusy || !tenantId}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handlePhotoUpload(file);
                          e.currentTarget.value = '';
                        }}
                      />
                    </label>
                    {selected.photoUrl && (
                      <button
                        type="button"
                        disabled={photoBusy}
                        onClick={() => void handlePhotoRemove()}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 text-[11px] font-bold text-rose-700 hover:bg-rose-50"
                      >
                        {t('inventory.remove')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="font-bold text-gray-500 uppercase">{t('inventory.qtyAvailable')}</span>
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
                  <span className="font-bold text-gray-500 uppercase">{t('inventory.listPrice')}</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    disabled={!permissions.canEditInventory}
                    value={selected.listPrice ?? ''}
                    onChange={(e) =>
                      saveSelected({
                        listPrice: e.target.value === '' ? null : Number(e.target.value)
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-gray-500 uppercase">{t('inventory.section')}</span>
                  <input
                    disabled={!permissions.canEditInventory}
                    value={selected.category || ''}
                    onChange={(e) => saveSelected({ category: e.target.value || undefined })}
                    placeholder={t('inventory.sectionPlaceholder')}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-gray-500 uppercase">{t('inventory.weeksUntilReady')}</span>
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
                  <Scissors className="h-3.5 w-3.5" /> {t('inventory.cutBack')}
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
                          cutBackNotes: t('inventory.cutBackRecorded')
                        })
                      }
                      className="px-3 py-2 rounded-lg bg-amber-50 text-amber-800 text-xs font-bold border border-amber-200"
                    >
                      {t('inventory.markCutBack')}
                    </button>
                  )}
                </div>
                {selected.cutBackNotes && (
                  <p className="text-xs text-gray-500 mt-2">{selected.cutBackNotes}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-bold uppercase text-gray-500 mb-2 flex items-center gap-1">
                  <Droplets className="h-3.5 w-3.5" /> {t('inventory.sprayHistory')}
                </p>
                <div className="space-y-2 mb-3">
                  {(selected.chemicals || []).length === 0 ? (
                    <p className="text-xs text-gray-400">{t('inventory.noSprays')}</p>
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
                      placeholder={t('inventory.chemicalName')}
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
                      className="rounded-lg bg-ink-700 text-white text-xs font-bold"
                    >
                      {t('inventory.logSpray')}
                    </button>
                  </form>
                )}
              </div>

              <div>
                <p className="text-xs font-bold uppercase text-gray-500 mb-2 flex items-center gap-1">
                  <Leaf className="h-3.5 w-3.5" /> {t('inventory.fertilizerHistory')}
                </p>
                <div className="space-y-2 mb-3">
                  {(selected.fertilizers || []).length === 0 ? (
                    <p className="text-xs text-gray-400">{t('inventory.noFertilizers')}</p>
                  ) : (
                    (selected.fertilizers || []).map((f, i) => (
                      <div
                        key={i}
                        className="text-xs bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-2"
                      >
                        <span className="font-bold text-gray-800">{f.fertilizerName}</span>
                        <span className="text-gray-500"> • {f.appliedAt.split('T')[0]}</span>
                        {f.notes && <p className="text-gray-500 mt-0.5">{f.notes}</p>}
                      </div>
                    ))
                  )}
                </div>
                {permissions.canEditInventory && (
                  <form onSubmit={handleAddFertilizer} className="grid sm:grid-cols-3 gap-2">
                    <input
                      required
                      value={fertName}
                      onChange={(e) => setFertName(e.target.value)}
                      placeholder={t('inventory.fertilizerKind')}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <input
                      type="date"
                      value={fertDate}
                      onChange={(e) => setFertDate(e.target.value)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg bg-emerald-700 text-white text-xs font-bold"
                    >
                      {t('inventory.logFertilizer')}
                    </button>
                  </form>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-12 text-center text-sm text-gray-500">
              {t('inventory.selectPlantDetail')}
            </div>
          )}
        </div>
      </div>

      {pdfSheet && (
        <PdfShareSheet
          url={pdfSheet.url}
          fileName={pdfSheet.fileName}
          blob={pdfSheet.blob}
          title={t('inventory.pdfReady')}
          onClose={() => setPdfSheet(null)}
        />
      )}
    </div>
  );
}
