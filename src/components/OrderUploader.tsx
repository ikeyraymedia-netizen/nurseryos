import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Upload, FileText, AlertCircle, RefreshCw, CheckCircle2, Users, Sprout, Plus, DollarSign, ClipboardList } from 'lucide-react';
import { addCustomerOrder } from '../lib/db';
import { findMatchingCustomers } from '../lib/customerMatch';
import {
  getInventoryMatchSuggestions,
  promptInventoryLink,
  rememberInventoryAlias,
  subscribeToInventory
} from '../lib/inventory';
import { findMatchingInventoryPlants } from '../lib/inventoryMatch';
import { addCustomerDocument, defaultDocumentNumber } from '../lib/documents';
import { getDefaultPriceForSize } from '../lib/pricing';
import { logAuditEvent } from '../lib/audit';
import { AppPermissions } from '../lib/permissions';
import { inferUploadMimeType, isAllowedOrderUploadMime } from '../lib/uploadMime';
import { ContainerWeight, Customer, InventoryPlant, PlantOrderItem, CustomerDocumentType } from '../types';

interface OrderUploaderProps {
  containerWeights: ContainerWeight[];
  customers: Customer[];
  tenantId: string;
  permissions: AppPermissions;
  onUploadSuccess: (orderId: string) => void;
  onCreateDocument?: (orderId: string, type: CustomerDocumentType) => void;
  onEstimateSaved?: (customerId: string) => void;
}

interface ParsedOrderDraft {
  customerName: string;
  orderNumber: string;
  items: PlantOrderItem[];
  originalText: string;
  totalWeightLbs: number;
  suggestedCustomerId: string;
  matchConfidence: 'exact' | 'fuzzy' | 'none';
  matchSuggestions: Customer[];
}

type UploadKind = 'order' | 'estimate';
type InputMode = 'file' | 'text';

export const OrderUploader: React.FC<OrderUploaderProps> = ({
  containerWeights,
  customers,
  tenantId,
  permissions,
  onUploadSuccess,
  onCreateDocument,
  onEstimateSaved
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('file');
  const [pastedText, setPastedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkingItemId, setLinkingItemId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ParsedOrderDraft | null>(null);
  const [uploadKind, setUploadKind] = useState<UploadKind | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [savedOrderId, setSavedOrderId] = useState<string | null>(null);
  const [savedEstimateCustomerId, setSavedEstimateCustomerId] = useState<string | null>(null);
  const [inventoryPlants, setInventoryPlants] = useState<InventoryPlant[]>([]);
  const [linkedInventoryByItemId, setLinkedInventoryByItemId] = useState<
    Record<string, { plantId: string; plantName: string; containerSize: string }>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeToInventory(setInventoryPlants), []);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  const calculateOrderWeight = (items: Omit<PlantOrderItem, 'id' | 'loadedQuantity'>[]): number => {
    return items.reduce((total, item) => {
      const match = containerWeights.find(
        (w) =>
          w.id.toLowerCase() === item.containerSize.toLowerCase() ||
          w.label.toLowerCase() === item.containerSize.toLowerCase()
      );
      const unitWeight = match ? match.weightLbs : 0;
      return total + unitWeight * item.quantity;
    }, 0);
  };

  const resetDraftState = () => {
    setPendingDraft(null);
    setUploadKind(null);
    setSelectedCustomerId('');
    setLinkedInventoryByItemId({});
  };

  const processFile = async (file: File, orderText?: string) => {
    setLoading(true);
    setSaving(false);
    setErrorMessage(null);
    resetDraftState();
    setSavedOrderId(null);
    setSavedEstimateCustomerId(null);
    setStatusMessage(orderText ? 'Reading pasted order...' : 'Reading file content...');

    try {
      const mimeType = inferUploadMimeType(file.name, file.type, orderText);
      if (!isAllowedOrderUploadMime(mimeType)) {
        throw new Error(
          'Unsupported file format. Please upload a PDF or image, or paste plain text.'
        );
      }

      let base64Data: string | undefined;
      if (!orderText) {
        if (file.size > 20 * 1024 * 1024) {
          throw new Error('File is too large. Please upload a PDF or image under 20MB.');
        }
        base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(file);
        });
      }

      setStatusMessage(
        orderText
          ? 'Parsing pasted order...'
          : 'Analyzing order document with Gemini AI (this may take up to a minute)...'
      );

      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 180_000);

      let response: Response;
      try {
        response = await fetch('/api/parse-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            ...(base64Data ? { base64Data } : {}),
            mimeType,
            fileName: file.name,
            ...(orderText ? { orderText } : {})
          })
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error(
            'Order analysis timed out. Try a clearer photo/PDF, or paste the plant list as text.'
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
            ? 'AI service is temporarily busy. Please wait 10 seconds and try again.'
            : errorData.error || 'Failed to parse order with Gemini.';
        const details =
          typeof errorData.details === 'string' && errorData.details.trim()
            ? ` ${errorData.details}`
            : '';
        throw new Error(`${friendly}${details}`);
      }

      const result = await response.json();
      const rawItems = Array.isArray(result.items) ? result.items : [];
      if (rawItems.length === 0) {
        throw new Error(
          'No plant lines found. Check quantity/size format (e.g. "10 - #3 Live Oak") and try again.'
        );
      }
      const itemsWithIds: PlantOrderItem[] = rawItems.map((item: any, index: number) => ({
        id: `item-${Date.now()}-${index}`,
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: item.quantity,
        loadedQuantity: 0,
        notes: item.notes || ''
      }));

      const parsedCustomerName = result.customerName || 'Unknown Customer';
      const match = findMatchingCustomers(parsedCustomerName, customers);
      const suggestedId = match.best?.id || '';

      setPendingDraft({
        customerName: parsedCustomerName,
        orderNumber: result.orderNumber || 'N/A',
        items: itemsWithIds,
        originalText: result.plainText || orderText || '',
        totalWeightLbs: calculateOrderWeight(itemsWithIds),
        suggestedCustomerId: suggestedId,
        matchConfidence: match.confidence,
        matchSuggestions: match.suggestions
      });
      setSelectedCustomerId(suggestedId);
      setUploadKind(null);
      setLinkedInventoryByItemId({});
      setPastedText('');
      setLoading(false);
      setStatusMessage('');
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'An unexpected error occurred while uploading.');
      setLoading(false);
    }
  };

  const linkItemToPlant = (item: PlantOrderItem, plant: InventoryPlant) => {
    rememberInventoryAlias(
      tenantId,
      item.plantName,
      item.containerSize,
      plant.plantName,
      plant.containerSize
    );
    setLinkedInventoryByItemId((prev) => ({
      ...prev,
      [item.id]: {
        plantId: plant.id,
        plantName: plant.plantName,
        containerSize: plant.containerSize
      }
    }));
  };

  const handleCreateAndLink = async (item: PlantOrderItem) => {
    setLinkingItemId(item.id);
    setErrorMessage(null);
    try {
      const linked = await promptInventoryLink(
        tenantId,
        inventoryPlants,
        item.plantName,
        item.containerSize,
        item.quantity,
        containerWeights
      );
      if (linked?.[0]) {
        linkItemToPlant(item, linked[0]);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to link plant to inventory.');
    } finally {
      setLinkingItemId(null);
    }
  };

  const getItemInventoryStatus = (item: PlantOrderItem) => {
    const manual = linkedInventoryByItemId[item.id];
    if (manual) {
      return { type: 'linked' as const, label: manual.plantName, containerSize: manual.containerSize };
    }
    const exact = findMatchingInventoryPlants(
      inventoryPlants,
      item.plantName,
      item.containerSize,
      containerWeights
    );
    if (exact.length > 0) {
      return { type: 'auto' as const, label: exact[0].plantName, containerSize: exact[0].containerSize };
    }
    return { type: 'unmatched' as const };
  };

  const saveDraft = async () => {
    if (!pendingDraft || !uploadKind) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const linked = selectedCustomer;

      if (uploadKind === 'estimate') {
        if (!linked?.id) {
          throw new Error('Pick a customer before saving an estimate. Estimates are saved under the customer only — not as a plant order.');
        }

        const lineItems = pendingDraft.items.map((item) => {
          const unitPrice = getDefaultPriceForSize(item.containerSize);
          return {
            id: item.id,
            plantName: item.plantName,
            containerSize: item.containerSize,
            quantity: item.quantity,
            unitPrice,
            notes: item.notes
          };
        });
        const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
        const taxRate = 0;
        const salesTax = 0;
        const freightCharge = 0;
        const discount = 0;
        const grandTotal = subtotal - discount + salesTax + freightCharge;
        const documentDate = new Date().toISOString().split('T')[0];

        await addCustomerDocument({
          customerId: linked.id,
          customerName: linked.name,
          orderNumber:
            pendingDraft.orderNumber !== 'N/A' ? pendingDraft.orderNumber : undefined,
          type: 'estimate',
          documentNumber: defaultDocumentNumber('estimate', pendingDraft.orderNumber),
          documentDate,
          paymentTerms: linked.paymentTerms || 'Net 30',
          taxRate,
          freightCharge,
          discount,
          notes: 'Estimate from uploaded paperwork. Not yet converted to a plant order.',
          billToName: linked.billingName || linked.name,
          billToAddress: linked.billingAddress || linked.shippingAddress || undefined,
          customerEmail: linked.contactEmail || undefined,
          items: lineItems,
          subtotal,
          salesTax,
          grandTotal
        });

        await logAuditEvent({
          action: 'estimate.saved_from_upload',
          summary: `Saved estimate for ${linked.name}`,
          meta: { customerId: linked.id, lines: lineItems.length }
        });

        resetDraftState();
        setSavedEstimateCustomerId(linked.id);
        onEstimateSaved?.(linked.id);
        return;
      }

      const orderId = await addCustomerOrder({
        customerName: linked?.name || pendingDraft.customerName,
        customerId: linked?.id || undefined,
        orderNumber: pendingDraft.orderNumber,
        items: pendingDraft.items,
        originalText: pendingDraft.originalText,
        status: 'pending',
        totalWeightLbs: pendingDraft.totalWeightLbs
      });

      await logAuditEvent({
        action: 'order.created_from_upload',
        summary: `Created order for ${linked?.name || pendingDraft.customerName}`,
        meta: { orderId, customerId: linked?.id || null }
      });

      resetDraftState();
      setSavedOrderId(orderId);
      onUploadSuccess(orderId);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
    e.currentTarget.value = '';
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const processPastedText = () => {
    const text = pastedText.trim();
    if (!text) {
      setErrorMessage('Paste the order text before continuing.');
      return;
    }
    const file = new File([text], 'pasted-order.txt', { type: 'text/plain' });
    void processFile(file, text);
  };

  return (
    <div id="uploader-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-emerald-700 border-x border-b border-slate-200/95 p-6">
      <div className="flex items-center space-x-2.5 mb-4">
        <Upload className="h-5 w-5 text-emerald-800 font-bold" />
        <h3 className="text-lg font-bold text-gray-900 font-sans">Add Order</h3>
      </div>

      <p className="text-sm text-slate-600 mb-4 leading-relaxed font-medium">
        Upload plant paperwork or paste plain text. After AI reads it, choose whether it’s an
        estimate (saved under the customer only) or a plant order for loading.
      </p>

      {!loading && !pendingDraft && !savedOrderId && !savedEstimateCustomerId && (
        <div className="space-y-3">
          <div className="flex rounded-xl bg-slate-100 border border-slate-200 p-1">
            <button
              type="button"
              onClick={() => {
                setInputMode('file');
                setErrorMessage(null);
              }}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
                inputMode === 'file'
                  ? 'bg-white text-emerald-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload File
            </button>
            <button
              type="button"
              onClick={() => {
                setInputMode('text');
                setErrorMessage(null);
              }}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
                inputMode === 'text'
                  ? 'bg-white text-emerald-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Paste Text
            </button>
          </div>

          {inputMode === 'file' ? (
            <div
              onClick={triggerFileInput}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center min-h-[180px] ${
                isDragging
                  ? 'border-emerald-500 bg-emerald-50/50'
                  : 'border-slate-300 bg-slate-50/30 hover:border-emerald-500 hover:bg-emerald-50/20 shadow-inner'
              }`}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
                className="hidden"
              />
              <div className="bg-emerald-100/80 p-3 rounded-full text-emerald-800 mb-3.5 shadow-sm">
                <FileText className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-gray-800">
                Drag & drop plant document here
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Supports PDFs, photos, invoices up to 20MB
              </p>
              <button
                type="button"
                className="mt-4 px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-lg shadow transition-colors"
              >
                Choose File
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
              <label
                htmlFor="pasted-order-text"
                className="block text-xs font-black uppercase tracking-wide text-slate-600 mb-2"
              >
                Paste customer order text
              </label>
              <textarea
                id="pasted-order-text"
                value={pastedText}
                onChange={(event) => {
                  setPastedText(event.target.value);
                  setErrorMessage(null);
                }}
                rows={10}
                placeholder={`Customer: Acme Landscape\nPO: 1042\n\n10 - #3 Live Oak\n6 - #7 Magnolia\n12 - #1 Dwarf Yaupon`}
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
              />
              <button
                type="button"
                onClick={processPastedText}
                disabled={!pastedText.trim()}
                className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Sprout className="h-4 w-4" />
                Analyze Pasted Text
              </button>
            </div>
          )}
        </div>
      )}

      {savedEstimateCustomerId && !loading && !pendingDraft && (
        <div className="border border-sky-200 rounded-xl p-4 bg-sky-50/50 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-sky-700" />
            <p className="text-sm font-bold text-gray-900">Estimate saved under customer</p>
          </div>
          <p className="text-xs text-gray-600 leading-relaxed">
            It was not added as a plant order. Open the customer to review it, or convert it to an
            order later when you’re ready to load.
          </p>
          <button
            type="button"
            onClick={() => {
              onEstimateSaved?.(savedEstimateCustomerId);
              setSavedEstimateCustomerId(null);
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-sky-700 text-white text-xs font-bold hover:bg-sky-800"
          >
            <Users className="h-4 w-4" />
            View customer
          </button>
          <button
            type="button"
            onClick={() => setSavedEstimateCustomerId(null)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50"
          >
            Done
          </button>
        </div>
      )}

      {savedOrderId && !loading && !pendingDraft && (
        <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50/40 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-700" />
            <p className="text-sm font-bold text-gray-900">Order saved</p>
          </div>
          <p className="text-xs text-gray-600 leading-relaxed">
            Set line pricing and save as an estimate or invoice under the customer. You can email or
            export a PDF from the next screen.
          </p>
          {permissions.canViewInvoices && onCreateDocument ? (
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => {
                  onCreateDocument(savedOrderId, 'estimate');
                  setSavedOrderId(null);
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-white border border-emerald-300 text-emerald-900 text-xs font-bold hover:bg-emerald-50"
              >
                <FileText className="h-4 w-4" />
                Create estimate (set pricing)
              </button>
              <button
                type="button"
                onClick={() => {
                  onCreateDocument(savedOrderId, 'invoice');
                  setSavedOrderId(null);
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800"
              >
                <DollarSign className="h-4 w-4" />
                Create invoice (set pricing)
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setSavedOrderId(null)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50"
          >
            Done — skip for now
          </button>
        </div>
      )}

      {loading && (
        <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-6 flex flex-col items-center text-center min-h-[180px] justify-center">
          <RefreshCw className="h-8 w-8 text-emerald-700 animate-spin mb-3" />
          <p className="text-sm font-semibold text-gray-800 mb-1">Processing Paperwork</p>
          <p className="text-xs text-gray-500 max-w-[240px] leading-relaxed">{statusMessage}</p>
        </div>
      )}

      {pendingDraft && !loading && uploadKind === null && (
        <div className="border border-amber-200 rounded-xl p-4 bg-amber-50/40 space-y-3">
          <p className="text-sm font-bold text-gray-900">Is this an estimate?</p>
          <p className="text-xs text-gray-600 leading-relaxed">
            Parsed <span className="font-semibold">{pendingDraft.customerName}</span>
            {pendingDraft.orderNumber !== 'N/A' ? ` • #${pendingDraft.orderNumber}` : ''} •{' '}
            {pendingDraft.items.length} line
            {pendingDraft.items.length === 1 ? '' : 's'}.
          </p>
          <button
            type="button"
            onClick={() => setUploadKind('estimate')}
            className="w-full text-left px-3 py-3 rounded-xl border border-sky-300 bg-white hover:bg-sky-50 transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-bold text-sky-900">
              <FileText className="h-4 w-4" />
              Yes — save as estimate
            </span>
            <span className="block text-[11px] text-sky-800/80 mt-1 leading-relaxed">
              Saves under the customer only. Does not create a plant order for loading yet.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setUploadKind('order')}
            className="w-full text-left px-3 py-3 rounded-xl border border-emerald-300 bg-white hover:bg-emerald-50 transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-bold text-emerald-900">
              <ClipboardList className="h-4 w-4" />
              No — this is a plant order
            </span>
            <span className="block text-[11px] text-emerald-800/80 mt-1 leading-relaxed">
              Adds it to Orders so you can pull, load, and put it on a truck.
            </span>
          </button>
          <button
            type="button"
            onClick={resetDraftState}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      )}

      {pendingDraft && !loading && uploadKind !== null && (
        <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50/30 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Users className="h-4 w-4 text-emerald-700 shrink-0" />
              <p className="text-sm font-bold text-gray-900 truncate">
                {uploadKind === 'estimate' ? 'Save estimate under customer' : 'Match customer before saving'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setUploadKind(null)}
              className="text-[11px] font-bold text-emerald-800 hover:underline shrink-0"
            >
              Change type
            </button>
          </div>

          <div className="text-xs text-gray-600 bg-white border border-gray-100 rounded-lg px-3 py-2">
            <span className="font-semibold text-gray-800">Parsed from document:</span>{' '}
            {pendingDraft.customerName}
            <span className="text-gray-400"> • #{pendingDraft.orderNumber}</span>
            <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-white border border-gray-200 text-gray-700">
              {uploadKind === 'estimate' ? 'Estimate' : 'Plant order'}
            </span>
          </div>

          {uploadKind === 'estimate' && (
            <p className="text-[11px] text-sky-900 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-2 leading-relaxed">
              Estimates require a linked customer and will not appear in Orders until you convert them
              later.
            </p>
          )}

          {pendingDraft.matchConfidence !== 'none' && pendingDraft.suggestedCustomerId && (
            <p className="text-xs font-semibold text-emerald-800">
              {pendingDraft.matchConfidence === 'exact'
                ? 'Exact customer match found.'
                : 'Similar customer match found — confirm or choose another.'}
            </p>
          )}

          {pendingDraft.matchSuggestions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Suggested matches</p>
              {pendingDraft.matchSuggestions.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => setSelectedCustomerId(customer.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs ${
                    selectedCustomerId === customer.id
                      ? 'border-emerald-500 bg-emerald-50 font-bold text-emerald-900'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  {customer.name}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">
              {uploadKind === 'estimate' ? 'Customer (required)' : 'Or choose any customer'}
            </label>
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white disabled:bg-gray-100"
            >
              <option value="">
                {uploadKind === 'estimate' ? 'Select a customer…' : 'No link — keep parsed name only'}
              </option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>

          {uploadKind === 'order' && (
          <div className="border-t border-emerald-200/80 pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <Sprout className="h-4 w-4 text-emerald-700" />
              <p className="text-sm font-bold text-gray-900">Link plants to inventory</p>
            </div>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Tap a suggestion to link each line. If nothing matches, use{' '}
              <span className="font-semibold text-emerald-800">Create new and link</span>.
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {pendingDraft.items.map((item) => {
                const status = getItemInventoryStatus(item);
                const suggestions =
                  status.type === 'unmatched'
                    ? getInventoryMatchSuggestions(
                        inventoryPlants,
                        item.plantName,
                        item.containerSize,
                        containerWeights
                      )
                    : [];

                return (
                  <div
                    key={item.id}
                    className="bg-white border border-gray-100 rounded-lg px-3 py-2.5 space-y-2"
                  >
                    <div className="text-xs font-bold text-gray-900">
                      {item.plantName}
                      <span className="font-normal text-gray-500">
                        {' '}
                        • {item.containerSize} • Qty {item.quantity}
                      </span>
                    </div>

                    {status.type !== 'unmatched' ? (
                      <p className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-md px-2 py-1">
                        ✓ Linked to {status.label} ({status.containerSize})
                        {status.type === 'auto' ? ' — auto-matched' : ''}
                      </p>
                    ) : (
                      <>
                        {suggestions.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
                              Suggested matches — tap to link
                            </p>
                            {suggestions.map(({ plant, score }) => (
                              <button
                                key={plant.id}
                                type="button"
                                disabled={linkingItemId === item.id}
                                onClick={() => linkItemToPlant(item, plant)}
                                className="w-full text-left px-2.5 py-2 rounded-md border border-gray-200 hover:border-emerald-400 hover:bg-emerald-50/60 text-[11px] disabled:opacity-50 touch-manipulation"
                              >
                                <span className="font-bold text-gray-900">{plant.plantName}</span>
                                <span className="text-gray-500"> • {plant.containerSize}</span>
                                <span className="text-gray-400"> • Qty {plant.quantityAvailable}</span>
                                {score < 1 && (
                                  <span className="text-amber-600 font-semibold ml-1">
                                    ({Math.round(score * 100)}%)
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}

                        {permissions.canEditInventory ? (
                          <button
                            type="button"
                            disabled={linkingItemId === item.id}
                            onClick={() => handleCreateAndLink(item)}
                            className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md border border-dashed border-emerald-400 text-emerald-900 text-[11px] font-bold hover:bg-emerald-50 disabled:opacity-50 touch-manipulation"
                          >
                            {linkingItemId === item.id ? (
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                            Create new and link
                          </button>
                        ) : suggestions.length === 0 ? (
                          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2 py-1">
                            No inventory match — ask someone with inventory access to add this
                            product.
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          )}

          {uploadKind === 'estimate' && (
            <div className="bg-white border border-gray-100 rounded-lg px-3 py-2 max-h-40 overflow-y-auto space-y-1">
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Line items</p>
              {pendingDraft.items.map((item) => (
                <p key={item.id} className="text-xs text-gray-700">
                  {item.plantName} • {item.containerSize} • Qty {item.quantity}
                </p>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={resetDraftState}
              disabled={saving}
              className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving || (uploadKind === 'estimate' && !selectedCustomerId)}
              className="flex-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              {saving ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {uploadKind === 'estimate'
                    ? `Save estimate${selectedCustomer ? ` for ${selectedCustomer.name}` : ''}`
                    : `Save order${selectedCustomer ? ` for ${selectedCustomer.name}` : ''}`}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mt-4 bg-red-50 border border-red-100 rounded-xl p-4 flex items-start space-x-2.5">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div className="text-xs text-red-800 leading-relaxed">
            <p className="font-bold">Upload Error</p>
            <p className="mt-1">{errorMessage}</p>
            {errorMessage.includes('GEMINI_API_KEY') && (
              <p className="mt-2 font-semibold text-red-900 bg-red-100/50 p-1.5 rounded">
                Please ask the administrator to configure the GEMINI_API_KEY secret in the settings.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
