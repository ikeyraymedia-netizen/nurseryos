import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Upload, FileText, AlertCircle, RefreshCw, CheckCircle2, Users, Sprout, Plus } from 'lucide-react';
import { addCustomerOrder } from '../lib/db';
import { findMatchingCustomers } from '../lib/customerMatch';
import {
  getInventoryMatchSuggestions,
  promptInventoryLink,
  rememberInventoryAlias,
  subscribeToInventory
} from '../lib/inventory';
import { findMatchingInventoryPlants } from '../lib/inventoryMatch';
import { AppPermissions } from '../lib/permissions';
import { ContainerWeight, Customer, InventoryPlant, PlantOrderItem } from '../types';

interface OrderUploaderProps {
  containerWeights: ContainerWeight[];
  customers: Customer[];
  tenantId: string;
  permissions: AppPermissions;
  onUploadSuccess: (orderId: string) => void;
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

export const OrderUploader: React.FC<OrderUploaderProps> = ({
  containerWeights,
  customers,
  tenantId,
  permissions,
  onUploadSuccess
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkingItemId, setLinkingItemId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ParsedOrderDraft | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
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

  const processFile = async (file: File) => {
    setLoading(true);
    setSaving(false);
    setErrorMessage(null);
    setPendingDraft(null);
    setSelectedCustomerId('');
    setLinkedInventoryByItemId({});
    setStatusMessage('Reading file content...');

    try {
      const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        throw new Error('Unsupported file format. Please upload a PDF or an image (PNG, JPEG, WebP).');
      }

      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });

      setStatusMessage('Analyzing order document with Gemini AI (this may take up to 20 seconds)...');

      const response = await fetch('/api/parse-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Data,
          mimeType: file.type,
          fileName: file.name
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const friendly =
          response.status === 503
            ? 'AI service is temporarily busy. Please wait 10 seconds and try again.'
            : errorData.error || 'Failed to parse order with Gemini.';
        throw new Error(friendly);
      }

      const result = await response.json();
      const itemsWithIds: PlantOrderItem[] = result.items.map((item: any, index: number) => ({
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
        originalText: result.plainText || '',
        totalWeightLbs: calculateOrderWeight(itemsWithIds),
        suggestedCustomerId: suggestedId,
        matchConfidence: match.confidence,
        matchSuggestions: match.suggestions
      });
      setSelectedCustomerId(suggestedId);
      setLinkedInventoryByItemId({});
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
    if (!pendingDraft) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const linked = selectedCustomer;
      const orderId = await addCustomerOrder({
        customerName: linked?.name || pendingDraft.customerName,
        customerId: linked?.id || undefined,
        orderNumber: pendingDraft.orderNumber,
        items: pendingDraft.items,
        originalText: pendingDraft.originalText,
        status: 'pending',
        totalWeightLbs: pendingDraft.totalWeightLbs
      });
      setPendingDraft(null);
      setSelectedCustomerId('');
      setLinkedInventoryByItemId({});
      onUploadSuccess(orderId);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save order.');
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

  return (
    <div id="uploader-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-emerald-700 border-x border-b border-slate-200/95 p-6">
      <div className="flex items-center space-x-2.5 mb-4">
        <Upload className="h-5 w-5 text-emerald-800 font-bold" />
        <h3 className="text-lg font-bold text-gray-900 font-sans">Upload New Order</h3>
      </div>

      <p className="text-sm text-slate-600 mb-4 leading-relaxed font-medium">
        Upload plant order paperwork. After AI reads the document, we auto-match the customer when
        possible — or you can pick the right one before saving.
      </p>

      {!loading && !pendingDraft && (
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
          <p className="text-sm font-semibold text-gray-800">Drag & drop plant order document here</p>
          <p className="text-xs text-gray-400 mt-1">Supports PDFs, photos, invoices up to 20MB</p>
          <button
            type="button"
            className="mt-4 px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-lg shadow transition-colors"
          >
            Choose File
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

      {pendingDraft && !loading && (
        <div className="border border-emerald-200 rounded-xl p-4 bg-emerald-50/30 space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-700" />
            <p className="text-sm font-bold text-gray-900">Match customer before saving</p>
          </div>

          <div className="text-xs text-gray-600 bg-white border border-gray-100 rounded-lg px-3 py-2">
            <span className="font-semibold text-gray-800">Parsed from document:</span>{' '}
            {pendingDraft.customerName}
            <span className="text-gray-400"> • Order #{pendingDraft.orderNumber}</span>
          </div>

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
              Or choose any customer
            </label>
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white disabled:bg-gray-100"
            >
              <option value="">No link — keep parsed name only</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>

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

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setPendingDraft(null);
                setSelectedCustomerId('');
                setLinkedInventoryByItemId({});
              }}
              disabled={saving}
              className="px-3 py-2 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving}
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
                  Save order
                  {selectedCustomer ? ` for ${selectedCustomer.name}` : ''}
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
            <p className="font-bold">Extraction Error</p>
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
