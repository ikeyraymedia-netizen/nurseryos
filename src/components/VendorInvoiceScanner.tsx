import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
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
import { Vendor } from '../types';
import { AppPermissions } from '../lib/permissions';
import { inferUploadMimeType, isAllowedOrderUploadMime } from '../lib/uploadMime';
import { findMatchingVendors } from '../lib/vendorMatch';
import { createVendorBill } from '../lib/purchasing';
import { addVendor } from '../lib/vendors';
import { uploadVendorInvoiceAttachment } from '../lib/vendorInvoicePhotos';
import { authJsonHeaders } from '../lib/apiAuth';
import {
  emptyBillLine,
  isPlantPurchaseCategory,
  normalizePurchaseCategory,
  purchaseCategoryLabel,
  resolvePurchaseCategory
} from '../lib/purchaseCategories';
import { PurchaseCategoryField } from './PurchaseCategoryField';
import { CREATE_NEW_VENDOR, VendorPicker } from './VendorPicker';
import { useT } from '../lib/i18n';
import { dueDateFromPaymentTerms, toDateKey } from '../lib/dates';

type InputMode = 'file' | 'text';

interface DraftLine {
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  category: string;
  notes?: string;
}

interface ParsedInvoiceDraft {
  vendorName: string;
  vendorInvoiceNumber: string;
  billDate: string;
  dueDate: string;
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
  return toDateKey(new Date(parsed));
}

/** Prefer invoice due date; otherwise compute from the vendor's saved payment terms. */
function resolveDueDate(
  billDate: string,
  invoiceDueDate: string,
  paymentTerms?: string | null
): string {
  if (invoiceDueDate) return invoiceDueDate;
  if (!paymentTerms) return '';
  return dueDateFromPaymentTerms(billDate || toDateKey(new Date()), paymentTerms) || '';
}

export function VendorInvoiceScanner({
  tenantId,
  vendors,
  permissions,
  onSaved
}: VendorInvoiceScannerProps) {
  const t = useT();
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
    () =>
      selectedVendorId && selectedVendorId !== CREATE_NEW_VENDOR
        ? vendors.find((v) => v.id === selectedVendorId) || null
        : null,
    [vendors, selectedVendorId]
  );

  // Auto-matched vendors skip VendorPicker onChange — fill due from saved terms when blank.
  useEffect(() => {
    if (!draft || !selectedVendor?.paymentTerms) return;
    if (draft.dueDate) return;
    const due = dueDateFromPaymentTerms(
      draft.billDate || toDateKey(new Date()),
      selectedVendor.paymentTerms
    );
    if (!due) return;
    setDraft((prev) => (prev && !prev.dueDate ? { ...prev, dueDate: due } : prev));
  }, [draft?.dueDate, draft?.billDate, selectedVendor?.id, selectedVendor?.paymentTerms]);

  const lineSubtotal = useMemo(() => {
    if (!draft) return 0;
    return draft.items.reduce(
      (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0),
      0
    );
  }, [draft]);

  const grandTotal = lineSubtotal;

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
    setStatusMessage(invoiceText ? t('scanner.readingPasted') : t('scanner.readingFile'));

    try {
      const mimeType = inferUploadMimeType(file.name, file.type, invoiceText);
      if (!isAllowedOrderUploadMime(mimeType)) {
        throw new Error(t('scanner.unsupportedFile'));
      }

      let base64Data: string | undefined;
      if (!invoiceText) {
        if (file.size > 20 * 1024 * 1024) {
          throw new Error(t('scanner.fileTooLarge'));
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
        invoiceText ? t('scanner.parsingPaste') : t('scanner.parsingLong')
      );

      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 180_000);

      let response: Response;
      try {
        response = await fetch('/api/parse-vendor-invoice', {
          method: 'POST',
          headers: await authJsonHeaders(),
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
          throw new Error(t('scanner.timeout'));
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(abortTimer);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const friendly =
          response.status === 503
            ? t('scanner.aiBusy')
            : errorData.error || t('scanner.parseFailed');
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
          const category = normalizePurchaseCategory(item.category, item.lineType);
          return {
            plantName: String(item.plantName || '').trim(),
            containerSize: isPlantPurchaseCategory(category)
              ? String(item.containerSize || '').trim() || 'Other'
              : String(item.containerSize || '').trim(),
            quantity: Math.max(0, Number(item.quantity) || 0) || 1,
            unitCost: Math.max(0, Number(item.unitCost) || 0),
            category,
            notes: item.notes ? String(item.notes) : undefined
          };
        })
        .filter((item: DraftLine) => item.plantName);

      // Header freight from AI → normal Freight line (same as other categories)
      const headerFreight = Math.max(0, Number(result.freightCharge) || 0);
      const hasFreightLine = items.some(
        (line) => purchaseCategoryLabel(line.category).toLowerCase() === 'freight'
      );
      if (headerFreight > 0 && !hasFreightLine) {
        items.push({
          plantName: 'Freight',
          containerSize: '',
          quantity: 1,
          unitCost: headerFreight,
          category: 'Freight'
        });
      }

      if (items.length === 0) {
        throw new Error(t('scanner.noLinesDetail'));
      }

      const vendorName = String(result.vendorName || '').trim() || t('scanner.unknownVendor');
      const match = findMatchingVendors(vendorName, vendors);
      const billDate = normalizeDate(result.billDate) || toDateKey(new Date());
      const invoiceDue = normalizeDate(result.dueDate);
      const dueDate = resolveDueDate(billDate, invoiceDue, match.best?.paymentTerms);

      setDraft({
        vendorName,
        vendorInvoiceNumber:
          String(result.vendorInvoiceNumber || '').trim() === 'N/A'
            ? ''
            : String(result.vendorInvoiceNumber || '').trim(),
        billDate,
        dueDate,
        notes: String(result.notes || '').trim(),
        items,
        matchConfidence: match.confidence,
        matchSuggestions: match.suggestions
      });
      setSelectedVendorId(match.best?.id || (permissions.canEditVendors ? CREATE_NEW_VENDOR : ''));
      setCreateVendorName(vendorName);
      setPastedText('');
      setStatusMessage('');
    } catch (err: unknown) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : t('scanner.readFailed'));
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
        if (selectedVendorId !== CREATE_NEW_VENDOR) {
          throw new Error(t('scanner.pickVendor'));
        }
        const name = createVendorName.trim() || draft.vendorName.trim();
        if (!name) {
          throw new Error(t('scanner.enterVendor'));
        }
        if (!permissions.canEditVendors) {
          throw new Error(t('scanner.pickExistingVendor'));
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
          containerSize: isPlantPurchaseCategory(line.category)
            ? line.containerSize.trim() || 'Other'
            : line.containerSize.trim(),
          quantity: Math.max(0, Number(line.quantity) || 0),
          unitCost: Math.max(0, Number(line.unitCost) || 0),
          category: resolvePurchaseCategory(line.category),
          notes: line.notes?.trim() || undefined
        }))
        .filter((line) => line.plantName && line.quantity > 0);

      if (items.length === 0) {
        throw new Error(t('scanner.addLineQty'));
      }

      const billId = `vbill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let invoicePhotoUrl: string | null = null;
      let invoicePhotoPath: string | null = null;

      if (pendingFile) {
        setStatusMessage(t('scanner.uploading'));
        const uploaded = await uploadVendorInvoiceAttachment({
          tenantId,
          billId,
          file: pendingFile
        });
        invoicePhotoUrl = uploaded.invoicePhotoUrl;
        invoicePhotoPath = uploaded.invoicePhotoPath;
      }

      setStatusMessage(t('scanner.saving'));
      const billDate = draft.billDate || toDateKey(new Date());
      const dueDate =
        resolveDueDate(billDate, draft.dueDate, vendor.paymentTerms) || undefined;
      const savedId = await createVendorBill({
        id: billId,
        vendorId: vendor.id,
        vendorName: vendor.name,
        billDate: draft.billDate || undefined,
        dueDate,
        notes: draft.notes || undefined,
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
      setErrorMessage(err instanceof Error ? err.message : t('scanner.saveFailed'));
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
            {t('scanner.title')}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">{t('scanner.subtitleDetail')}</p>
        </div>
        {draft && (
          <button
            type="button"
            onClick={resetDraft}
            className="text-[11px] font-bold text-slate-500 hover:text-slate-800"
          >
            {t('scanner.clear')}
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
              {t('scanner.photoFile')}
            </button>
            <button
              type="button"
              onClick={() => setInputMode('text')}
              className={`px-3 py-1.5 text-[11px] font-bold ${
                inputMode === 'text' ? 'bg-ink-700 text-white' : 'bg-white text-ink-800'
              }`}
            >
              {t('scanner.pasteText')}
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
                {t('scanner.takePhoto')}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 px-3 py-3 rounded-xl border border-dashed border-ink-300 bg-white text-xs font-bold text-ink-800 hover:bg-ink-50 disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                {t('scanner.uploadFile')}
              </button>
            </div>
          ) : (
            <form onSubmit={handlePasteSubmit} className="space-y-2">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={6}
                placeholder={t('scanner.pastePlaceholder')}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={loading || !pastedText.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                {t('scanner.parseText')}
              </button>
            </form>
          )}
        </>
      )}

      {(loading || statusMessage) && (
        <p className="text-xs font-semibold text-ink-800 flex items-center gap-2">
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {statusMessage || t('scanner.working')}
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
            <p className="text-[11px] font-bold uppercase text-slate-500">{t('vendor.vendor')}</p>
            <VendorPicker
              vendors={vendors}
              vendorId={selectedVendorId}
              newVendorName={createVendorName}
              onVendorIdChange={(id) => {
                setSelectedVendorId(id);
                if (!id || id === CREATE_NEW_VENDOR) return;
                const vendor = vendors.find((v) => v.id === id);
                if (!vendor?.paymentTerms) return;
                setDraft((prev) => {
                  if (!prev) return prev;
                  // Always apply this vendor's terms when invoice didn't include a due date
                  // (or user switched vendors — use the newly selected vendor's terms).
                  const base = prev.billDate || toDateKey(new Date());
                  const due = dueDateFromPaymentTerms(base, vendor.paymentTerms);
                  return due ? { ...prev, dueDate: due } : prev;
                });
              }}
              onNewVendorNameChange={setCreateVendorName}
              allowCreate={permissions.canEditVendors}
              aiHint={draft.vendorName}
              matchLabel={
                draft.matchConfidence !== 'none' &&
                selectedVendorId &&
                selectedVendorId !== CREATE_NEW_VENDOR
                  ? t('scanner.matchLabel', { confidence: draft.matchConfidence })
                  : undefined
              }
              suggestions={draft.matchSuggestions}
            />
          </div>

          <div className="grid sm:grid-cols-3 gap-2">
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('scanner.vendorInv')}</span>
              <input
                value={draft.vendorInvoiceNumber}
                onChange={(e) =>
                  setDraft({ ...draft, vendorInvoiceNumber: e.target.value })
                }
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('scanner.billDate')}</span>
              <input
                type="date"
                value={draft.billDate}
                onChange={(e) => {
                  const next = e.target.value;
                  const due = selectedVendor?.paymentTerms
                    ? dueDateFromPaymentTerms(
                        next || toDateKey(new Date()),
                        selectedVendor.paymentTerms
                      ) || draft.dueDate
                    : draft.dueDate;
                  setDraft({ ...draft, billDate: next, dueDate: due });
                }}
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-bold text-slate-600">{t('scanner.dueDate')}</span>
              <input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                className="mt-1 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm"
              />
              {selectedVendor?.paymentTerms && (
                <span className="mt-1 block text-[10px] text-slate-500">
                  {t('purchasing.terms', { terms: selectedVendor.paymentTerms })}
                </span>
              )}
            </label>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-bold uppercase text-slate-500">{t('scanner.lineItems')}</p>
            {draft.items.map((line, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-slate-100 bg-white p-2 space-y-1.5"
              >
                <div className="grid grid-cols-12 gap-1.5 items-start">
                  <input
                    value={line.plantName}
                    onChange={(e) => {
                      const items = [...draft.items];
                      items[idx] = { ...line, plantName: e.target.value };
                      setDraft({ ...draft, items });
                    }}
                    placeholder={t('purchasing.description')}
                    className="col-span-11 sm:col-span-7 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                  />
                  <div className="col-span-11 sm:col-span-4">
                    <PurchaseCategoryField
                      value={line.category}
                      onChange={(category) => {
                        const items = [...draft.items];
                        items[idx] = { ...line, category };
                        setDraft({ ...draft, items });
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        items: draft.items.filter((_, i) => i !== idx)
                      })
                    }
                    className="col-span-1 text-rose-600 flex items-center justify-center pt-2"
                    disabled={draft.items.length === 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-12 gap-1.5">
                  {isPlantPurchaseCategory(line.category) && (
                    <label className="col-span-4 block">
                      <span className="text-[9px] font-bold uppercase text-slate-500">
                        {t('purchasing.size')}
                      </span>
                      <input
                        value={line.containerSize}
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[idx] = { ...line, containerSize: e.target.value };
                          setDraft({ ...draft, items });
                        }}
                        placeholder={t('purchasing.sizePlaceholder')}
                        className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                      />
                    </label>
                  )}
                  <label
                    className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                  >
                    <span className="text-[9px] font-bold uppercase text-slate-500">
                      {t('common.qty')}
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={line.quantity || ''}
                      placeholder="0"
                      onChange={(e) => {
                        const items = [...draft.items];
                        items[idx] = { ...line, quantity: Number(e.target.value) || 0 };
                        setDraft({ ...draft, items });
                      }}
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                  </label>
                  <label
                    className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                  >
                    <span className="text-[9px] font-bold uppercase text-slate-500">
                      {t('purchasing.costEach')}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitCost || ''}
                      onChange={(e) => {
                        const items = [...draft.items];
                        items[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                        setDraft({ ...draft, items });
                      }}
                      placeholder="0.00"
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                  </label>
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
              {t('purchasing.addLine')}
            </button>
          </div>

          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={2}
            placeholder={t('scanner.notesPlaceholder')}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-700">
              {t('scanner.total')}{' '}
              <span className="text-ink-800">{money(grandTotal)}</span>
              {pendingFile && (
                <span className="ml-2 font-semibold text-slate-500">{t('scanner.scanAttached')}</span>
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
                {t('scanner.startOver')}
              </button>
              <button
                type="button"
                disabled={
                  saving ||
                  (selectedVendorId === CREATE_NEW_VENDOR
                    ? !createVendorName.trim()
                    : !selectedVendorId)
                }
                onClick={() => void handleSaveDraft()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {t('scanner.saveBill')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
