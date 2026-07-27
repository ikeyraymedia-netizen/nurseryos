import { FormEvent, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react';
import { Vendor, PurchaseLineCategory, PurchaseLineType } from '../types';
import { AppPermissions } from '../lib/permissions';
import { inferUploadMimeType, isAllowedOrderUploadMime } from '../lib/uploadMime';
import { findMatchingVendors } from '../lib/vendorMatch';
import { createVendorBill } from '../lib/purchasing';
import { addVendor } from '../lib/vendors';
import { uploadVendorInvoiceAttachment } from '../lib/vendorInvoicePhotos';
import {
  PURCHASE_CATEGORIES,
  PURCHASE_LINE_TYPES,
  defaultCategoryForType,
  emptyBillLine,
  normalizePurchaseCategory,
  normalizePurchaseLineType
} from '../lib/purchaseCategories';

type InputMode = 'file' | 'text';

interface DraftLine {
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  lineType: PurchaseLineType;
  category: PurchaseLineCategory;
  notes?: string;
}

interface ParsedInvoiceDraft {
  vendorName: string;
  vendorInvoiceNumber: string;
  billDate: string;
  dueDate: string;
  freightCharge: number;
  notes: string;
  items: DraftLine[];
  matchConfidence: 'exact' | 'fuzzy' | 'none';
  matchSuggestions: Vendor[];
}

interface VendorInvoiceScannerProps {
  tenantId: string;
  vendors: Vendor[];
  permissions: AppPermissions;
  onSaved?: (billId: string) => void;
}

function money(n: number) {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function normalizeDate(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

export function VendorInvoiceScanner({
  tenantId,
  vendors,
  permissions,
  onSaved
}: VendorInvoiceScannerProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [inputMode, setInputMode] = useState<InputMode>('file');
  const [pastedText, setPastedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<ParsedInvoiceDraft | null>(null);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [createVendorName, setCreateVendorName] = useState('');

  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === selectedVendorId) || null,
    [vendors, selectedVendorId]
  );

  const lineSubtotal = useMemo(() => {
    if (!draft) return 0;
    return draft.items.reduce(
      (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0),
      0
    );
  }, [draft]);

  const grandTotal = lineSubtotal + (draft?.freightCharge || 0);

  function resetDraft() {
    setDraft(null);
    setSelectedVendorId('');
    setPendingFile(null);
    setCreateVendorName('');
    setStatusMessage('');
  }

  async function processUpload(file: File, invoiceText?: string) {
    if (!permissions.canManageVendorBills) return;
    setLoading(true);
    setSaving(false);
    setErrorMessage(null);
    resetDraft();
    setStatusMessage(invoiceText ? 'Reading pasted invoice…' : 'Reading file…');

    try {
      const mimeType = inferUploadMimeType(file.name, file.type, invoiceText);
      if (!isAllowedOrderUploadMime(mimeType)) {
        throw new Error('Unsupported file. Upload a photo, PDF, or paste plain text.');
      }

      let base64Data: string | undefined;
      if (!invoiceText) {
        if (file.size > 20 * 1024 * 1024) {
          throw new Error('File is too large. Please keep photos/PDFs under 20MB.');
        }
        base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(file);
        });
        setPendingFile(file);
      }

      setStatusMessage(
        invoiceText
          ? 'Parsing pasted invoice with AI…'
          : 'Analyzing vendor invoice with AI (this may take up to a minute)…'
      );

      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 180_000);

      let response: Response;
      try {
        response = await fetch('/api/parse-vendor-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            ...(base64Data ? { base64Data } : {}),
            mimeType,
            fileName: file.name,
            ...(invoiceText ? { invoiceText } : {})
          })
        });
      } catch (fetchErr: unknown) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new Error(
            'Invoice analysis timed out. Try a clearer photo/PDF, or paste the line items as text.'
          );
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(abortTimer);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const friendly =
          response.status === 503
            ? 'AI service is temporarily busy. Wait a few seconds and try again.'
            : errorData.error || 'Failed to parse vendor invoice.';
        const details =
          typeof errorData.details === 'string' && errorData.details.trim()
            ? ` ${errorData.details}`
            : '';
        throw new Error(`${friendly}${details}`);
      }

      const result = await response.json();
      const rawItems = Array.isArray(result.items) ? result.items : [];
      const items: DraftLine[] = rawItems
        .map((item: Record<string, unknown>) => {
          const lineType = normalizePurchaseLineType(item.lineType);
          return {
            plantName: String(item.plantName || '').trim(),
            containerSize:
              lineType === 'plant'
                ? String(item.containerSize || '').trim() || 'Other'
                : String(item.containerSize || '').trim(),
            quantity: Math.max(0, Number(item.quantity) || 0) || 1,
            unitCost: Math.max(0, Number(item.unitCost) || 0),
            lineType,
            category: normalizePurchaseCategory(item.category, lineType),
            notes: item.notes ? String(item.notes) : undefined
          };
        })
        .filter((item: DraftLine) => item.plantName);

      if (items.length === 0) {
        throw new Error(
          'No purchase lines found. Try a clearer photo, or paste the invoice lines as text.'
        );
      }

      const vendorName = String(result.vendorName || '').trim() || 'Unknown vendor';
      const match = findMatchingVendors(vendorName, vendors);

      setDraft({
        vendorName,
        vendorInvoiceNumber:
          String(result.vendorInvoiceNumber || '').trim() === 'N/A'
            ? ''
            : String(result.vendorInvoiceNumber || '').trim(),
        billDate: normalizeDate(result.billDate),
        dueDate: normalizeDate(result.dueDate),
        freightCharge: Math.max(0, Number(result.freightCharge) || 0),
        notes: String(result.notes || '').trim(),
        items,
        matchConfidence: match.confidence,
        matchSuggestions: match.suggestions
      });
      setSelectedVendorId(match.best?.id || '');
      setCreateVendorName(vendorName);
      setPastedText('');
      setStatusMessage('');
    } catch (err: unknown) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Could not read that invoice.');
      setPendingFile(null);
    } finally {
      setLoading(false);
    }
  }

  async function handlePasteSubmit(e: FormEvent) {
    e.preventDefault();
    const text = pastedText.trim();
    if (!text) return;
    const fakeFile = new File([text], 'pasted-invoice.txt', { type: 'text/plain' });
    await processUpload(fakeFile, text);
  }

  async function handleSaveDraft() {
    if (!draft || !permissions.canManageVendorBills) return;
    let vendor = selectedVendor;
    setSaving(true);
    setErrorMessage(null);
    try {
      if (!vendor) {
        const name = createVendorName.trim() || draft.vendorName.trim();
        if (!name) {
          throw new Error('Select a vendor, or enter a name to create one.');
        }
        if (!permissions.canEditVendors) {
          throw new Error('Pick an existing vendor from the list.');
        }
        const id = await addVendor({ name });
        vendor = {
          id,
          name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        setSelectedVendorId(id);
      }

      const items = draft.items
        .map((line) => ({
          plantName: line.plantName.trim(),
          containerSize:
            line.lineType === 'plant'
              ? line.containerSize.trim() || 'Other'
              : line.containerSize.trim(),
          quantity: Math.max(0, Number(line.quantity) || 0),
          unitCost: Math.max(0, Number(line.unitCost) || 0),
          lineType: line.lineType,
          category: line.category,
          notes: line.notes?.trim() || undefined
        }))
        .filter((line) => line.plantName && line.quantity > 0);

      if (items.length === 0) {
        throw new Error('Add at least one line with a quantity.');
      }

      const billId = `vbill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let invoicePhotoUrl: string | null = null;
      let invoicePhotoPath: string | null = null;

      if (pendingFile) {
        setStatusMessage('Uploading invoice scan…');
        const uploaded = await uploadVendorInvoiceAttachment({
          tenantId,
          billId,
          file: pendingFile
        });
        invoicePhotoUrl = uploaded.invoicePhotoUrl;
        invoicePhotoPath = uploaded.invoicePhotoPath;
      }

      setStatusMessage('Saving vendor bill…');
      const savedId = await createVendorBill({
        id: billId,
        vendorId: vendor.id,
        vendorName: vendor.name,
        billDate: draft.billDate || undefined,
        dueDate: draft.dueDate || undefined,
        notes: draft.notes || undefined,
        freightCharge: draft.freightCharge || undefined,
        vendorInvoiceNumber: draft.vendorInvoiceNumber || undefined,
        invoicePhotoUrl,
        invoicePhotoPath,
        items
      });

      resetDraft();
      setStatusMessage('');
      onSaved?.(savedId);
    } catch (err: unknown) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Could not save vendor bill.');
    } finally {
      setSaving(false);
      setStatusMessage('');
    }
  }

  if (!permissions.canManageVendorBills) return null;

  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-ink-900">
            Scan vendor invoice
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Upload any nursery purchase — plants, soil, pots, chemicals, freight. AI fills the
            bill; you confirm the vendor and categories.
          </p>
        </div>
        {draft && (
          <button
            type="button"
            onClick={resetDraft}
            className="text-[11px] font-bold text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        )}
      </div>

      {!draft && (
        <>
          <div className="inline-flex rounded-lg border border-ink-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setInputMode('file')}
              className={`px-3 py-1.5 text-[11px] font-bold ${
                inputMode === 'file' ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
              }`}
            >
              Photo / file
            </button>
            <button
              type="button"
              onClick={() => setInputMode('text')}
              className={`px-3 py-1.5 text-[11px] font-bold ${
                inputMode === 'text' ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
              }`}
            >
              Paste text
            </button>
          </div>

          {inputMode === 'file' ? (
            <div className="grid sm:grid-cols-2 gap-2">
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void processUpload(file);
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf,text/plain,.pdf,.png,.jpg,.jpeg,.webp,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void processUpload(file);
                }}
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => cameraInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-ink-300 bg-white text-xs font-bold text-ink-800 hover:bg-ink-50 disabled:opacity-50"
              >
                <Camera className="h-4 w-4" />
                Take photo
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-ink-300 bg-white text-xs font-bold text-ink-800 hover:bg-ink-50 disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                Upload file
              </button>
            </div>
          ) : (
            <form onSubmit={handlePasteSubmit} className="space-y-2">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={6}
                placeholder="Paste vendor invoice text here…"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={loading || !pastedText.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                Parse text
              </button>
            </form>
          )}
        </>
      )}

      {(loading || statusMessage) && (
        <p className="text-xs font-semibold text-ink-800 flex items-center gap-2">
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {statusMessage || 'Working…'}
        </p>
      )}

      {errorMessage && (
        <p className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{errorMessage}</span>
        </p>
      )}

      {draft && (
        <div className="space-y-3">
          <div className="rounded-lg border border-ink-100 bg-white p-3 space-y-2">
            <p className="text-[11px] font-bold uppercase text-slate-500">Vendor</p>
            <p className="text-sm font-semibold text-slate-800">
              AI read: <span className="text-ink-800">{draft.vendorName}</span>
              {draft.matchConfidence !== 'none' && selectedVendor && (
                <span className="ml-2 text-[10px] font-bold uppercase text-emerald-700">
                  {draft.matchConfidence} match
                </span>
              )}
            </p>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">Confirm vendor</span>
              <select
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                <option value="">Select vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.matchSuggestions.length > 0 && !selectedVendorId && (
              <div className="flex flex-wrap gap-1.5">
                {draft.matchSuggestions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVendorId(v.id)}
                    className="text-[10px] font-bold px-2 py-1 rounded-full bg-ink-50 text-ink-800 border border-ink-100"
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            )}
            {!selectedVendorId && permissions.canEditVendors && (
              <label className="block text-xs">
                <span className="font-bold text-slate-600">Or create new vendor</span>
                <input
                  value={createVendorName}
                  onChange={(e) => setCreateVendorName(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  placeholder="New vendor name"
                />
              </label>
            )}
          </div>

          <div className="grid sm:grid-cols-4 gap-2">
            <label className="block text-xs">
              <span className="font-bold text-slate-600">Vendor inv #</span>
              <input
                value={draft.vendorInvoiceNumber}
                onChange={(e) =>
                  setDraft({ ...draft, vendorInvoiceNumber: e.target.value })
                }
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">Bill date</span>
              <input
                type="date"
                value={draft.billDate}
                onChange={(e) => setDraft({ ...draft, billDate: e.target.value })}
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">Due date</span>
              <input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">Freight</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={draft.freightCharge}
                onChange={(e) =>
                  setDraft({ ...draft, freightCharge: Number(e.target.value) || 0 })
                }
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-bold uppercase text-slate-500">Line items</p>
            {draft.items.map((line, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-slate-100 bg-white p-2 space-y-1.5"
              >
                <div className="grid grid-cols-12 gap-1.5">
                  <input
                    value={line.plantName}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = { ...line, plantName: e.target.value };
                      setDraft({ ...draft, items });
                    }}
                    placeholder="Plant or supply description"
                    className="col-span-11 sm:col-span-5 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                  <select
                    value={line.lineType}
                    onChange={(e) => {
                      const lineType = e.target.value as PurchaseLineType;
                      const items = [...draft.items];
                      items[idx] = {
                        ...line,
                        lineType,
                        category: defaultCategoryForType(lineType)
                      };
                      setDraft({ ...draft, items });
                    }}
                    className="col-span-6 sm:col-span-3 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  >
                    {PURCHASE_LINE_TYPES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={line.category}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = {
                        ...line,
                        category: e.target.value as PurchaseLineCategory
                      };
                      setDraft({ ...draft, items });
                    }}
                    className="col-span-5 sm:col-span-3 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  >
                    {PURCHASE_CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        items: draft.items.filter((_, i) => i !== idx)
                      })
                    }
                    className="col-span-1 text-rose-600 flex items-center justify-center"
                    disabled={draft.items.length === 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-12 gap-1.5">
                  <input
                    value={line.containerSize}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = { ...line, containerSize: e.target.value };
                      setDraft({ ...draft, items });
                    }}
                    placeholder={line.lineType === 'plant' ? 'Size' : 'Size (optional)'}
                    className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                  <input
                    type="number"
                    min={0}
                    value={line.quantity}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = { ...line, quantity: Number(e.target.value) || 0 };
                      setDraft({ ...draft, items });
                    }}
                    className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.unitCost}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                      setDraft({ ...draft, items });
                    }}
                    placeholder="Unit cost"
                    className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  items: [...draft.items, { ...emptyBillLine() }]
                })
              }
              className="text-[11px] font-bold text-ink-700"
            >
              + Add line
            </button>
          </div>

          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={2}
            placeholder="Notes / payment terms"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-700">
              Subtotal {money(lineSubtotal)}
              {draft.freightCharge > 0 ? ` + freight ${money(draft.freightCharge)}` : ''}
              {' = '}
              <span className="text-ink-800">{money(grandTotal)}</span>
              {pendingFile && (
                <span className="ml-2 font-semibold text-slate-500">· scan attached</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={resetDraft}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-600"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Start over
              </button>
              <button
                type="button"
                disabled={saving || (!selectedVendorId && !createVendorName.trim())}
                onClick={() => void handleSaveDraft()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Save vendor bill
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
