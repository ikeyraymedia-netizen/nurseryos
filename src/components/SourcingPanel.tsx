import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2, Upload } from 'lucide-react';
import { Vendor, VendorAvailabilityLine } from '../types';
import { AppPermissions } from '../lib/permissions';
import { useT } from '../lib/i18n';
import {
  clearVendorAvailability,
  parseVendorAvailabilityFile,
  replaceVendorAvailabilityFromUpload,
  searchVendorAvailabilityLines,
  subscribeToVendorAvailabilityLines
} from '../lib/vendorAvailability';
import { logAuditEvent } from '../lib/audit';

interface SourcingPanelProps {
  vendors: Vendor[];
  permissions: AppPermissions;
  search: string;
  onStatus: (msg: string | null) => void;
  onError: (msg: string | null) => void;
}

export function SourcingPanel({
  vendors,
  permissions,
  search,
  onStatus,
  onError
}: SourcingPanelProps) {
  const t = useT();
  const canWrite = permissions.canEditPurchaseOrders || permissions.canEditVendors;
  const [lines, setLines] = useState<VendorAvailabilityLine[]>([]);
  const [uploadVendorId, setUploadVendorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [filterVendorId, setFilterVendorId] = useState('');

  useEffect(() => {
    return subscribeToVendorAvailabilityLines(setLines);
  }, []);

  useEffect(() => {
    if (!uploadVendorId && vendors.length === 1) {
      setUploadVendorId(vendors[0].id);
    }
  }, [vendors, uploadVendorId]);

  const filtered = useMemo(() => {
    const base = filterVendorId
      ? lines.filter((l) => l.vendorId === filterVendorId)
      : lines;
    return searchVendorAvailabilityLines(base, search);
  }, [lines, search, filterVendorId]);

  const vendorStats = useMemo(() => {
    const map = new Map<string, { name: string; count: number; importedAt?: string }>();
    for (const line of lines) {
      const prev = map.get(line.vendorId);
      if (!prev) {
        map.set(line.vendorId, {
          name: line.vendorName,
          count: 1,
          importedAt: line.importedAt
        });
      } else {
        prev.count += 1;
        if (line.importedAt && (!prev.importedAt || line.importedAt > prev.importedAt)) {
          prev.importedAt = line.importedAt;
        }
      }
    }
    return [...map.entries()]
      .map(([vendorId, v]) => ({ vendorId, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [lines]);

  async function handleUpload(file: File | null) {
    if (!file || !canWrite) return;
    const vendor = vendors.find((v) => v.id === uploadVendorId);
    if (!vendor) {
      onError(t('purchasing.sourcingPickVendor'));
      return;
    }
    setBusy(true);
    setUploadStatus('');
    onError(null);
    onStatus(null);
    try {
      const rows = await parseVendorAvailabilityFile(file, setUploadStatus);
      if (rows.length === 0) {
        throw new Error(t('purchasing.sourcingNoRows'));
      }
      setUploadStatus(t('purchasing.sourcingSaving', { count: String(rows.length) }));
      const result = await replaceVendorAvailabilityFromUpload({
        vendorId: vendor.id,
        vendorName: vendor.name,
        file,
        rows
      });
      await logAuditEvent({
        action: 'sourcing.availability_uploaded',
        summary: `Uploaded ${result.imported} availability lines for ${vendor.name}`,
        meta: {
          vendorId: vendor.id,
          imported: result.imported,
          replaced: result.replaced,
          fileName: file.name
        }
      });
      onStatus(
        t('purchasing.sourcingUploadDone', {
          count: String(result.imported),
          vendor: vendor.name
        })
      );
    } catch (err: any) {
      onError(err?.message || t('purchasing.sourcingUploadFailed'));
    } finally {
      setBusy(false);
      setUploadStatus('');
    }
  }

  async function handleClear(vendorId: string, vendorName: string) {
    if (!canWrite) return;
    if (
      !window.confirm(
        t('purchasing.sourcingClearConfirm', { vendor: vendorName })
      )
    ) {
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const n = await clearVendorAvailability(vendorId);
      onStatus(t('purchasing.sourcingCleared', { count: String(n), vendor: vendorName }));
    } catch (err: any) {
      onError(err?.message || t('purchasing.sourcingClearFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-ink-100 bg-white p-4 space-y-3">
        <div>
          <h3 className="text-sm font-black text-slate-900">{t('purchasing.sourcingTitle')}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{t('purchasing.sourcingIntro')}</p>
        </div>

        {canWrite ? (
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <label className="flex-1 block">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                {t('purchasing.sourcingVendor')}
              </span>
              <select
                value={uploadVendorId}
                onChange={(e) => setUploadVendorId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold"
              >
                <option value="">{t('purchasing.sourcingPickVendor')}</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold ${
                busy || !uploadVendorId
                  ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                  : 'bg-ink-700 text-white hover:bg-ink-800 cursor-pointer'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              {busy ? t('purchasing.sourcingUploading') : t('purchasing.sourcingUpload')}
              <input
                type="file"
                accept=".csv,.txt,.xlsx,.xls,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                disabled={busy || !uploadVendorId}
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  e.target.value = '';
                  void handleUpload(file);
                }}
              />
            </label>
          </div>
        ) : (
          <p className="text-xs text-slate-500">{t('purchasing.sourcingReadOnly')}</p>
        )}
        {uploadStatus && (
          <p className="text-[11px] font-semibold text-ink-700">{uploadStatus}</p>
        )}

        {vendorStats.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {vendorStats.map((v) => (
              <div
                key={v.vendorId}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px]"
              >
                <button
                  type="button"
                  onClick={() =>
                    setFilterVendorId((prev) => (prev === v.vendorId ? '' : v.vendorId))
                  }
                  className={`font-bold ${
                    filterVendorId === v.vendorId ? 'text-ink-800' : 'text-slate-700'
                  }`}
                >
                  {v.name}
                  <span className="ml-1 font-mono text-slate-400">{v.count}</span>
                </button>
                {canWrite && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleClear(v.vendorId, v.name)}
                    className="text-slate-400 hover:text-rose-600"
                    title={t('purchasing.sourcingClear')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {filterVendorId && (
              <button
                type="button"
                onClick={() => setFilterVendorId('')}
                className="text-[11px] font-bold text-ink-700 hover:underline"
              >
                {t('purchasing.sourcingShowAll')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-slate-700 inline-flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            {search.trim()
              ? t('purchasing.sourcingResults', { count: String(filtered.length) })
              : t('purchasing.sourcingAllLines', { count: String(filtered.length) })}
          </p>
        </div>

        {lines.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-500 text-center">
            {t('purchasing.sourcingEmpty')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-500 text-center">
            {t('purchasing.sourcingNoMatches')}
          </p>
        ) : (
          <div className="overflow-x-auto max-h-[28rem]">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 font-bold">
                <tr>
                  <th className="px-3 py-2">{t('purchasing.sourcingColPlant')}</th>
                  <th className="px-3 py-2">{t('purchasing.sourcingColSize')}</th>
                  <th className="px-3 py-2">{t('purchasing.sourcingColVendor')}</th>
                  <th className="px-3 py-2 text-right">{t('purchasing.sourcingColQty')}</th>
                  <th className="px-3 py-2 text-right">{t('purchasing.sourcingColPrice')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 300).map((line) => (
                  <tr key={line.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-3 py-2 font-semibold text-slate-900">
                      {line.plantName}
                      {line.category ? (
                        <span className="block text-[10px] font-normal text-slate-400">
                          {line.category}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-600">{line.containerSize}</td>
                    <td className="px-3 py-2 text-slate-700">{line.vendorName}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {line.quantityAvailable > 0 ? line.quantityAvailable : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {typeof line.listPrice === 'number' ? `$${line.listPrice.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 300 && (
              <p className="px-3 py-2 text-[11px] text-slate-500 border-t border-slate-100">
                {t('purchasing.sourcingTruncated', { count: String(filtered.length) })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
