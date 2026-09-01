import React, { useEffect, useState } from 'react';
import {
  FileText,
  ListTodo,
  CheckCircle2,
  Undo2,
  Clipboard,
  ClipboardCheck,
  Weight,
  Plus,
  Minus,
  Check,
  Building,
  Info,
  ChevronRight,
  AlertCircle,
  Truck,
  MapPin,
  Trash2,
  Edit,
  DollarSign
} from 'lucide-react';
import { CustomerOrder, ContainerWeight, Customer, CustomerDocument, CustomerDocumentType } from '../types';
import { AppPermissions } from '../lib/permissions';
import { orderRefLabel } from '../lib/orderLabels';
import {
  updateOrderItemProgress,
  updateOrderItemPulledProgress,
  updateOrderItemVendor,
  updateOrderItemCost,
  markAllItemsAsLoaded,
  resetOrderProgress,
  setOrderDirectShip,
  updateCustomerOrder
} from '../lib/db';
import { isDirectShipOrder } from '../lib/orderVisibility';
import { notifyInventorySyncIssue } from '../lib/inventory';
import { orderNeedsInvoiceSave } from '../lib/invoicing';
import { listAllDocuments } from '../lib/documents';
import { DEFAULT_VENDORS } from '../data/vendors';
import { useSalesRepOptions } from '../lib/salesReps';
import { InvoiceModal } from './InvoiceModal';
import { useT } from '../lib/i18n';
import { usePlantDisplay } from '../lib/usePlantDisplay';
import { notifyPushEvent } from '../lib/pushNotifications';

interface LoaderWorkspaceProps {
  order: CustomerOrder;
  orders?: CustomerOrder[];
  containerWeights: ContainerWeight[];
  customers: Customer[];
  permissions: AppPermissions;
  nurseryName?: string;
  nurseryAddress?: string;
  nurseryLogoSrc?: string | null;
  tenantId?: string;
}

export const LoaderWorkspace: React.FC<LoaderWorkspaceProps> = ({
  order,
  orders = [],
  containerWeights,
  customers,
  permissions,
  nurseryName = 'NurseryOS',
  nurseryAddress = '',
  nurseryLogoSrc = null,
  tenantId
}) => {
  const t = useT();
  const dp = usePlantDisplay();
  const salesRepOptions = useSalesRepOptions(tenantId);
  const [activeTab, setActiveTab] = useState<'checklist' | 'plaintext'>('checklist');
  const [copied, setCopied] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showLoadAllConfirm, setShowLoadAllConfirm] = useState(false);
  const [isInvoiceOpen, setIsInvoiceOpen] = useState(false);
  const [documentType, setDocumentType] = useState<CustomerDocumentType>('invoice');
  const [editingVendorItemId, setEditingVendorItemId] = useState<string | null>(null);
  const [tempVendorName, setTempVendorName] = useState('');

  // Editing existing items
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editPlantName, setEditPlantName] = useState('');
  const [editContainerSize, setEditContainerSize] = useState('');
  const [editQuantity, setEditQuantity] = useState(1);
  const [editNotes, setEditNotes] = useState('');
  const [editIsAddition, setEditIsAddition] = useState(false);
  const [needsInvoiceSave, setNeedsInvoiceSave] = useState(false);

  useEffect(() => {
    if (!permissions.canViewInvoices) {
      setNeedsInvoiceSave(false);
      return;
    }
    let cancelled = false;
    listAllDocuments()
      .then((docs: CustomerDocument[]) => {
        if (!cancelled) setNeedsInvoiceSave(orderNeedsInvoiceSave(order, docs));
      })
      .catch(() => {
        if (!cancelled) setNeedsInvoiceSave(false);
      });
    return () => {
      cancelled = true;
    };
  }, [order, permissions.canViewInvoices, isInvoiceOpen]);

  const handleVendorSave = async (itemId: string, vendorName: string) => {
    try {
      await updateOrderItemVendor(order.id, itemId, vendorName.trim(), order.items);
      setEditingVendorItemId(null);
    } catch (err) {
      console.error('Error saving item vendor:', err);
    }
  };

  const handleCostSave = async (itemId: string, rawValue: string) => {
    const trimmed = rawValue.trim();
    const parsed = trimmed === '' ? undefined : Number(trimmed);
    const current = order.items.find((i) => i.id === itemId)?.unitCost;
    const next = parsed === undefined || Number.isNaN(parsed) ? undefined : parsed;
    if (next === current) return;
    try {
      await updateOrderItemCost(order.id, itemId, next, order.items);
    } catch (err) {
      console.error('Error saving item cost:', err);
    }
  };

  const handleAssignOwner = async (owner: string) => {
    if (!permissions.canEditOrders) return;
    try {
      await updateCustomerOrder({ ...order, owner: owner || undefined });
    } catch (err) {
      console.error('Error assigning order owner:', err);
    }
  };

  const [stagedLocation, setStagedLocation] = useState(order.stagedLocation || '');
  const [savingStagedLocation, setSavingStagedLocation] = useState(false);
  const [directShipBusy, setDirectShipBusy] = useState(false);
  const saveTimeoutRef = React.useRef<any>(null);

  React.useEffect(() => {
    setStagedLocation(order.stagedLocation || '');
  }, [order.id, order.stagedLocation]);

  React.useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleStagedLocationChange = (value: string) => {
    setStagedLocation(value);
    setSavingStagedLocation(true);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await updateCustomerOrder({
          ...order,
          stagedLocation: value.trim() || undefined
        });
      } catch (err) {
        console.error('Failed to update staged location:', err);
      } finally {
        setSavingStagedLocation(false);
      }
    }, 800);
  };

  const handleDirectShipToggle = async (enabled: boolean) => {
    if (!permissions.canViewDirectShipOrders || directShipBusy) return;
    if (enabled === isDirectShipOrder(order)) return;
    setDirectShipBusy(true);
    try {
      await setOrderDirectShip(order, enabled);
    } catch (err) {
      console.error('Failed to update direct ship:', err);
    } finally {
      setDirectShipBusy(false);
    }
  };

  // Form states for adding a plant to existing order
  const [isAddingPlant, setIsAddingPlant] = useState(false);
  const [newPlantName, setNewPlantName] = useState('');
  const [newContainerSize, setNewContainerSize] = useState('');
  const [newQuantity, setNewQuantity] = useState(1);
  const [newVendorName, setNewVendorName] = useState('');
  const [newIsAddition, setNewIsAddition] = useState(true);
  const [newNotes, setNewNotes] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const handleAssignCustomer = async (customerId: string) => {
    if (!permissions.canEditOrders) return;
    if (!customerId) {
      await updateCustomerOrder({ ...order, customerId: undefined });
      return;
    }
    const selected = customers.find((c) => c.id === customerId);
    if (!selected) return;
    await updateCustomerOrder({
      ...order,
      customerId: selected.id,
      customerName: selected.name
    });
  };

  const handleAddPlantSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);

    if (!newPlantName.trim()) {
      setAddError(t('loader.plantNameRequired'));
      return;
    }
    if (!newContainerSize) {
      setAddError(t('loader.sizeRequired'));
      return;
    }
    if (newQuantity <= 0) {
      setAddError('Quantity must be at least 1');
      return;
    }

    try {
      const newItem = {
        id: `item-add-${Date.now()}`,
        plantName: newPlantName.trim(),
        containerSize: newContainerSize,
        quantity: Number(newQuantity) || 1,
        loadedQuantity: 0,
        pulledQuantity: 0,
        notes: newNotes.trim() || undefined,
        vendor: permissions.canUseVendors ? newVendorName.trim() || undefined : undefined,
        isAddition: newIsAddition,
        addedAt: new Date().toISOString()
      };

      const updatedItems = [...order.items, newItem];

      let totalQty = 0;
      let totalLoaded = 0;
      updatedItems.forEach((item) => {
        totalQty += item.quantity;
        totalLoaded += item.loadedQuantity;
      });
      
      let status: 'pending' | 'loading' | 'completed' = 'pending';
      if (totalLoaded > 0) {
        status = totalLoaded >= totalQty ? 'completed' : 'loading';
      }

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        status
      });

      if (tenantId) {
        void notifyPushEvent({
          tenantId,
          type: 'plant_added',
          title: `Plant added · ${order.customerName}`,
          body: `${newItem.plantName} (${newItem.containerSize}) × ${newItem.quantity}${
            newItem.isAddition ? ' · addition' : ''
          }`,
          url: `/?tab=orders&order=${order.id}`
        });
      }

      // Reset form on success
      setNewPlantName('');
      setNewContainerSize('');
      setNewQuantity(1);
      setNewVendorName('');
      setNewIsAddition(true);
      setNewNotes('');
      setIsAddingPlant(false);
    } catch (err: any) {
      console.error('Error adding plant to order:', err);
      setAddError(err.message || t('loader.addFailed'));
    }
  };

  const getContainerUnitWeight = (size: string): number => {
    const match = containerWeights.find(
      (w) => w.id.toLowerCase() === size.toLowerCase() ||
             w.label.toLowerCase() === size.toLowerCase()
    );
    return match ? match.weightLbs : 0;
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(order.originalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleQuantityChange = async (itemId: string, increment: boolean) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    let newQty = item.loadedQuantity + (increment ? 1 : -1);
    if (newQty < 0) newQty = 0;
    if (newQty > item.quantity) newQty = item.quantity;

    const note = await updateOrderItemProgress(
      order.id,
      itemId,
      newQty,
      order.items,
      order.items.length
    );
    notifyInventorySyncIssue(note);
  };

  const handleMarkItemFullyLoaded = (itemId: string) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    const isFullyLoaded = item.loadedQuantity === item.quantity;
    const newQty = isFullyLoaded ? 0 : item.quantity;

    void updateOrderItemProgress(
      order.id,
      itemId,
      newQty,
      order.items,
      order.items.length
    )
      .then(notifyInventorySyncIssue)
      .catch((err) => console.error('Failed to mark item fully loaded:', err));
  };

  const handlePulledQuantityChange = async (itemId: string, increment: boolean) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    let newQty = (item.pulledQuantity ?? 0) + (increment ? 1 : -1);
    if (newQty < 0) newQty = 0;
    if (newQty > item.quantity) newQty = item.quantity;

    await updateOrderItemPulledProgress(
      order.id,
      itemId,
      newQty,
      order.items,
      order.items.length
    );
  };

  const handleMarkItemFullyPulled = (itemId: string) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    const isFullyPulled = (item.pulledQuantity ?? 0) === item.quantity;
    const newQty = isFullyPulled ? 0 : item.quantity;

    void updateOrderItemPulledProgress(
      order.id,
      itemId,
      newQty,
      order.items,
      order.items.length
    ).catch((err) => console.error('Failed to mark item fully pulled:', err));
  };

  const handleLoadAll = async () => {
    const note = await markAllItemsAsLoaded(order.id, order.items);
    notifyInventorySyncIssue(note);
    setShowLoadAllConfirm(false);
  };

  const handleReset = async () => {
    const note = await resetOrderProgress(order.id, order.items);
    notifyInventorySyncIssue(note);
    setShowResetConfirm(false);
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!window.confirm('Are you sure you want to delete this item?')) return;
    try {
      const updatedItems = order.items.filter((item) => item.id !== itemId);
      let totalQty = 0;
      let totalLoaded = 0;
      updatedItems.forEach((item) => {
        totalQty += item.quantity;
        totalLoaded += item.loadedQuantity;
      });
      let status: 'pending' | 'loading' | 'completed' = 'pending';
      if (totalLoaded > 0) {
        status = totalLoaded >= totalQty ? 'completed' : 'loading';
      }

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        status
      });
    } catch (err) {
      console.error('Error deleting item:', err);
    }
  };

  const handleSaveEditedItem = async (itemId: string) => {
    try {
      const updatedItems = order.items.map((item) => {
        if (item.id === itemId) {
          const newTotalQty = Number(editQuantity) || 1;
          const loadedQty = Math.min(item.loadedQuantity, newTotalQty);
          const pulledQty = Math.min(item.pulledQuantity ?? 0, newTotalQty);
          return {
            ...item,
            plantName: editPlantName.trim(),
            containerSize: editContainerSize,
            quantity: newTotalQty,
            loadedQuantity: loadedQty,
            pulledQuantity: pulledQty,
            notes: editNotes.trim() || undefined,
            isAddition: editIsAddition
          };
        }
        return item;
      });

      let totalQty = 0;
      let totalLoaded = 0;
      updatedItems.forEach((item) => {
        totalQty += item.quantity;
        totalLoaded += item.loadedQuantity;
      });
      let status: 'pending' | 'loading' | 'completed' = 'pending';
      if (totalLoaded > 0) {
        status = totalLoaded >= totalQty ? 'completed' : 'loading';
      }

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        status
      });
      setEditingItemId(null);
    } catch (err) {
      console.error('Error saving edited item:', err);
    }
  };

  // Calculate loaded weight vs total weight
  const totalWeight = order.totalWeightLbs;
  const loadedWeight = order.items.reduce((sum, item) => {
    const unitWeight = getContainerUnitWeight(item.containerSize);
    return sum + (unitWeight * item.loadedQuantity);
  }, 0);

  const pulledWeight = order.items.reduce((sum, item) => {
    const unitWeight = getContainerUnitWeight(item.containerSize);
    return sum + (unitWeight * (item.pulledQuantity ?? 0));
  }, 0);

  const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const loadedQuantity = order.items.reduce((sum, item) => sum + item.loadedQuantity, 0);
  const pulledQuantity = order.items.reduce((sum, item) => sum + (item.pulledQuantity ?? 0), 0);
  const remainingToPull = Math.max(0, totalQuantity - pulledQuantity);
  const remainingToLoad = Math.max(0, totalQuantity - loadedQuantity);

  return (
    <div id="loader-workspace-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-ink-700 border-x border-b border-slate-200/95 p-6 flex flex-col h-full relative pb-24 sm:pb-6">
      
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-5 mb-5 gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-ink-100 text-ink-950 border border-ink-300 font-mono">
              ORDER IN WORKSPACE
            </span>
            <span className="text-xs text-slate-500 font-mono font-bold">ID: {order.id.slice(0, 6)}</span>
          </div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight font-sans mt-1">
            {order.customerName}
          </h2>
          <p className="text-sm text-slate-600 font-mono flex items-center mt-0.5">
            <Building className="h-4 w-4 mr-1 text-slate-500" />
            {(() => {
              const ref = orderRefLabel(order);
              if (!ref) return null;
              if (ref.startsWith('PO ')) {
                return (
                  <>
                    PO: <span className="font-bold text-gray-700 ml-1">{ref.slice(3)}</span>
                  </>
                );
              }
              return (
                <>
                  Invoice / Order #: <span className="font-bold text-gray-700 ml-1">{ref}</span>
                </>
              );
            })()}
          </p>
          {permissions.canEditOrders && (
            <div className="mt-3 max-w-md" onClick={(e) => e.stopPropagation()}>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">
                {t('loader.changeCustomer')}
              </label>
              <select
                value={order.customerId || ''}
                onChange={(e) => void handleAssignCustomer(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-sm font-semibold bg-white text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-ink-500/15 focus:border-ink-600"
              >
                <option value="">
                  {order.customerName && !order.customerId
                    ? t('loader.keepNameOnly', { name: order.customerName })
                    : t('loader.unassigned')}
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-slate-500 mt-1">{t('loader.changeCustomerHint')}</p>
            </div>
          )}
        </div>

        {/* Global Loading Stepper Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {permissions.canViewInvoices && (
            <>
              <button
                onClick={() => {
                  setDocumentType('estimate');
                  setIsInvoiceOpen(true);
                }}
                className="px-3 py-1.5 bg-white hover:bg-sky-50 text-sky-900 border border-sky-200 text-xs font-bold rounded-lg shadow-sm transition-all flex items-center space-x-1"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>{t('loader.createEstimate')}</span>
              </button>
              <button
                onClick={() => {
                  setDocumentType('invoice');
                  setIsInvoiceOpen(true);
                }}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center space-x-1"
              >
                <DollarSign className="h-3.5 w-3.5" />
                <span>{t('loader.createInvoice')}</span>
              </button>
            </>
          )}

          {permissions.canEditOrders && showResetConfirm ? (
            <div className="flex items-center bg-amber-50 border border-amber-200 rounded-lg p-1 space-x-1">
              <span className="text-[10px] font-bold text-amber-800 px-1">{t('loader.resetCounts')}</span>
              <button
                onClick={handleReset}
                className="px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] rounded"
              >
                Yes
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-2 py-0.5 bg-white border border-gray-200 text-gray-700 font-bold text-[10px] rounded"
              >
                No
              </button>
            </div>
          ) : permissions.canCheckOffLoading && showLoadAllConfirm ? (
            <div className="flex items-center bg-ink-50 border border-ink-200 rounded-lg p-1 space-x-1">
              <span className="text-[10px] font-bold text-ink-800 px-1">{t('loader.loadAllPlants')}</span>
              <button
                onClick={handleLoadAll}
                className="px-2 py-0.5 bg-ink-700 hover:bg-ink-800 text-white font-bold text-[10px] rounded"
              >
                Yes
              </button>
              <button
                onClick={() => setShowLoadAllConfirm(false)}
                className="px-2 py-0.5 bg-white border border-gray-200 text-gray-700 font-bold text-[10px] rounded"
              >
                No
              </button>
            </div>
          ) : (
            <>
              {permissions.canEditOrders && (
                <button
                  onClick={() => setShowResetConfirm(true)}
                  disabled={loadedQuantity === 0}
                  className="px-3 py-1.5 border border-gray-200 hover:border-amber-300 hover:bg-amber-50 text-gray-600 hover:text-amber-800 text-xs font-bold rounded-lg transition-all flex items-center space-x-1 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  <span>{t('loader.resetTruck')}</span>
                </button>
              )}
              {permissions.canCheckOffLoading && (
                <button
                  onClick={() => setShowLoadAllConfirm(true)}
                  disabled={loadedQuantity === totalQuantity}
                  className="px-3 py-1.5 bg-ink-700 hover:bg-ink-800 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center space-x-1 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>{t('loader.loadAll')}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {permissions.canViewInvoices && needsInvoiceSave && (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5">
          <p className="text-xs text-amber-950 leading-relaxed">{t('loader.invoiceNotSaved')}</p>
          <button
            type="button"
            onClick={() => {
              setDocumentType('invoice');
              setIsInvoiceOpen(true);
            }}
            className="inline-flex items-center justify-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-bold"
          >
            <DollarSign className="h-3.5 w-3.5" />
            {t('loader.saveInvoice')}
          </button>
        </div>
      )}

      {(permissions.canEditOrders || permissions.canViewInvoices) && (
        <div className="bg-white border border-ink-200 rounded-xl p-3 mb-5 shadow-sm">
          <label className="block text-[10px] font-bold text-ink-900 uppercase mb-1">
            Sales Rep
          </label>
          <select
            value={order.owner || ''}
            onChange={(e) => handleAssignOwner(e.target.value)}
            className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm bg-white"
          >
            <option value="">{t('loader.selectSalesRep')}</option>
            {salesRepOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {order.owner && !salesRepOptions.includes(order.owner) && (
              <option value={order.owner}>{order.owner}</option>
            )}
          </select>
          <p className="text-[10px] text-gray-500 mt-1 leading-snug">
            Credits this order for tracking and reports. Works even if the order is never put on a
            truck.
          </p>
        </div>
      )}

      {permissions.canViewDirectShipOrders ? (
        <div className="bg-sky-50/70 border border-sky-100 rounded-xl p-3 mb-5 shadow-sm">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={isDirectShipOrder(order)}
              disabled={directShipBusy}
              onChange={(e) => void handleDirectShipToggle(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-sky-700 focus:ring-sky-500 disabled:opacity-50"
            />
            <span>
              <span className="block text-sm font-bold text-gray-900">{t('upload.directShipLabel')}</span>
              <span className="block text-[10px] text-gray-600 leading-snug mt-0.5">
                {t('loader.directShipToggleHint')}
              </span>
              {order.truckId && !isDirectShipOrder(order) ? (
                <span className="block text-[10px] text-amber-700 leading-snug mt-1">
                  {t('loader.directShipRemovingFromTruck')}
                </span>
              ) : null}
            </span>
          </label>
        </div>
      ) : null}

      {/* Staging Location Card */}
      <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-4 mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center space-x-3 shrink-0">
          <div className="bg-ink-100 text-ink-800 p-2 rounded-xl border border-ink-200 shadow-sm">
            <MapPin className="h-5 w-5" />
          </div>
          <div>
            <h4 className="text-xs font-black text-gray-800 uppercase tracking-wider font-mono">{t('loader.stagingLocation')}</h4>
            <p className="text-xs text-slate-500 font-medium mt-0.5">{t('loader.stagingHint')}</p>
          </div>
        </div>
        
        <div className="flex-1 max-w-md relative">
          <input
            type="text"
            placeholder={t('loader.stagingPlaceholder')}
            value={stagedLocation}
            readOnly={!permissions.canEditOrders}
            onChange={(e) => permissions.canEditOrders && handleStagedLocationChange(e.target.value)}
            className="block w-full px-4 py-2 bg-white border border-slate-300 rounded-xl text-sm font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-ink-500/10 focus:border-ink-600 transition-all shadow-inner disabled:bg-slate-100"
          />
          {savingStagedLocation && (
            <div className="absolute right-3 top-2.5 flex items-center space-x-1.5 bg-ink-50 border border-ink-150 px-2 py-0.5 rounded-lg">
              <span className="w-1.5 h-1.5 bg-ink-600 rounded-full animate-ping" />
              <span className="text-[10px] font-bold text-ink-700 font-mono">{t('loader.saving')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Weight Summary Panel */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-ink-50/75 border border-ink-300 rounded-2xl p-4 mb-5 shadow-sm">
        
        {/* Total Weight Stat */}
        <div className="flex items-center space-x-3.5">
          <div className="bg-ink-700/10 p-2.5 rounded-xl text-ink-800 shrink-0 border border-ink-700/20">
            <Weight className="h-5.5 w-5.5" />
          </div>
          <div>
            <p className="text-xs font-bold text-ink-800/80 uppercase tracking-wide font-mono">{t('loader.totalWeight')}</p>
            <p className="text-2xl font-black text-gray-900 font-mono tracking-tight">
              {totalWeight.toLocaleString()} <span className="text-xs font-semibold text-gray-500">{t('common.lbs')}</span>
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5 leading-none">{t('loader.weightHint')}</p>
          </div>
        </div>

        {/* Delivered / Pulled Progress Stat */}
        <div>
          <div className="flex justify-between items-baseline mb-1">
            <p className="text-xs font-bold text-ink-800/80 uppercase tracking-wide font-mono font-bold">{t('loader.deliveredPulled')}</p>
            <p className="text-xs font-bold font-mono text-ink-800">
              {pulledWeight.toLocaleString()} / {totalWeight.toLocaleString()} lbs
            </p>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-gray-200 h-2.5 rounded-full overflow-hidden mb-1 border border-gray-100">
            <div
              className="bg-teal-600 h-full rounded-full transition-all duration-300"
              style={{ width: `${totalWeight > 0 ? (pulledWeight / totalWeight) * 100 : 0}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 font-medium">
            {t('loader.pulledProgress', {
              pulled: pulledQuantity,
              total: totalQuantity,
              pct: totalQuantity > 0 ? Math.round((pulledQuantity / totalQuantity) * 100) : 0
            })}
          </p>
        </div>

        {/* Loading Progress Stat */}
        <div>
          <div className="flex justify-between items-baseline mb-1">
            <p className="text-xs font-bold text-ink-800/80 uppercase tracking-wide font-mono">{t('loader.onTruckProgress')}</p>
            <p className="text-xs font-bold font-mono text-ink-800">
              {loadedWeight.toLocaleString()} / {totalWeight.toLocaleString()} lbs
            </p>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-gray-200 h-2.5 rounded-full overflow-hidden mb-1 border border-gray-100">
            <div
              className="bg-ink-700 h-full rounded-full transition-all duration-300"
              style={{ width: `${totalWeight > 0 ? (loadedWeight / totalWeight) * 100 : 0}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 font-medium">
            {t('loader.loadedProgress', {
              loaded: loadedQuantity,
              total: totalQuantity,
              pct: totalQuantity > 0 ? Math.round((loadedQuantity / totalQuantity) * 100) : 0
            })}
          </p>
        </div>

      </div>

      {/* View Switcher Tabs */}
      <div className="flex border-b border-gray-100 mb-5">
        <button
          onClick={() => setActiveTab('checklist')}
          className={`flex items-center space-x-2 px-4 py-2.5 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'checklist'
              ? 'border-ink-700 text-ink-800 bg-ink-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <ListTodo className="h-4.5 w-4.5" />
          <span>{t('loader.interactiveList')}</span>
        </button>
        <button
          onClick={() => setActiveTab('plaintext')}
          className={`flex items-center space-x-2 px-4 py-2.5 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'plaintext'
              ? 'border-ink-700 text-ink-800 bg-ink-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <FileText className="h-4.5 w-4.5" />
          <span>{t('loader.plainText')}</span>
        </button>
      </div>

      {/* Workspace Body */}
      <div className="flex-1 overflow-y-auto min-h-[300px]">
        {activeTab === 'checklist' ? (
          <div className="space-y-1.5 pr-1">
            {/* Quick Add Plant Action */}
            {permissions.canEditOrders && (
              !isAddingPlant ? (
              <button
                type="button"
                onClick={() => setIsAddingPlant(true)}
                className="w-full py-2 px-4 border border-dashed border-ink-300 hover:border-ink-500 bg-ink-50/20 hover:bg-ink-50/50 text-ink-800 hover:text-ink-900 font-bold text-sm rounded-xl transition-all flex items-center justify-center space-x-2 shadow-sm mb-2"
              >
                <Plus className="h-4.5 w-4.5 stroke-[2.5px]" />
                <span>{t('loader.addPlant')}</span>
              </button>
            ) : (
              <form
                onSubmit={handleAddPlantSubmit}
                className="bg-white border-2 border-ink-500 rounded-xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in"
              >
                <div className="flex items-center justify-between border-b border-gray-100 pb-2">
                  <h4 className="text-sm font-bold text-gray-900 flex items-center">
                    <Plus className="h-4 w-4 mr-1 text-ink-700" />
                    Add Plant to Order
                  </h4>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingPlant(false);
                      setAddError(null);
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 font-bold"
                  >
                    Cancel
                  </button>
                </div>

                {addError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-lg flex items-center space-x-1.5">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{addError}</span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="col-span-1 sm:col-span-2">
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Plant Name / Variety *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Dwarf Burford Holly"
                      value={newPlantName}
                      onChange={(e) => setNewPlantName(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Container Size *
                    </label>
                    <select
                      value={newContainerSize}
                      onChange={(e) => setNewContainerSize(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      required
                    >
                      <option value="">{t('loader.selectSize')}</option>
                      {containerWeights.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({w.weightLbs} lbs)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div
                  className={`grid grid-cols-1 gap-3 ${
                    permissions.canUseVendors ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
                  }`}
                >
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Quantity *
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={newQuantity}
                      onChange={(e) => setNewQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-mono font-bold text-gray-800"
                      required
                    />
                  </div>
                  {permissions.canUseVendors && (
                    <div>
                      <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                        Assign Vendor (Optional)
                      </label>
                      <input
                        type="text"
                        list="vendors-list-loader"
                        placeholder={t('loader.vendorPlaceholder')}
                        value={newVendorName}
                        onChange={(e) => setNewVendorName(e.target.value)}
                        className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Optional Notes
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Late addition / Tag-along"
                      value={newNotes}
                      onChange={(e) => setNewNotes(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <label className="flex items-center space-x-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={newIsAddition}
                      onChange={(e) => setNewIsAddition(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-350 text-ink-700 focus:ring-ink-500 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-amber-800 bg-amber-50 px-2 py-1 rounded border border-amber-200 flex items-center space-x-1">
                      <span>⚠️ Mark as addition (notifies loaders)</span>
                    </span>
                  </label>

                  <button
                    type="submit"
                    className="px-4 py-2 bg-ink-700 hover:bg-ink-800 text-white font-bold text-xs rounded-lg shadow-sm transition-all flex items-center space-x-1"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('loader.savePlant')}</span>
                  </button>
                </div>
              </form>
            ))}

            {order.items.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                No items extracted for this order.
              </div>
            ) : (
              order.items.map((item) => {
                const unitWeight = getContainerUnitWeight(item.containerSize);
                const itemTotalWeight = unitWeight * item.quantity;
                const isFullyLoaded = item.loadedQuantity === item.quantity;
                const isFullyPulled = (item.pulledQuantity ?? 0) === item.quantity;
                const isEditing = editingItemId === item.id;

                return (
                  <div
                    key={item.id}
                    className={`border rounded-lg p-2 transition-all shadow-sm ${
                      isEditing
                        ? 'border-ink-600 bg-slate-50'
                        : isFullyLoaded && isFullyPulled
                        ? 'border-ink-600 bg-ink-50/30'
                        : isFullyLoaded
                        ? 'border-ink-500/50 bg-ink-50/15'
                        : isFullyPulled
                        ? 'border-teal-500/40 bg-teal-50/10'
                        : 'border-slate-250 bg-white hover:border-slate-400'
                    }`}
                  >
                    {isEditing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSaveEditedItem(item.id);
                        }}
                        className="space-y-3 w-full"
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div className="sm:col-span-2">
                            <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                              Plant Name / Variety
                            </label>
                            <input
                              type="text"
                              value={editPlantName}
                              onChange={(e) => setEditPlantName(e.target.value)}
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-ink-500 bg-white font-medium text-gray-800"
                              required
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                              Size
                            </label>
                            <select
                              value={editContainerSize}
                              onChange={(e) => setEditContainerSize(e.target.value)}
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-ink-500 bg-white font-medium text-gray-800"
                              required
                            >
                              {containerWeights.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div>
                            <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                              Total Qty
                            </label>
                            <input
                              type="number"
                              min="1"
                              value={editQuantity}
                              onChange={(e) => setEditQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-ink-500 bg-white font-mono font-bold text-gray-800"
                              required
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                              Notes
                            </label>
                            <input
                              type="text"
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-ink-500 bg-white font-medium text-gray-800"
                              placeholder={t('loader.optionalNotes')}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-gray-200">
                          <label className="flex items-center space-x-1.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={editIsAddition}
                              onChange={(e) => setEditIsAddition(e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-gray-300 text-ink-700 focus:ring-ink-500 cursor-pointer"
                            />
                            <span className="text-[10px] font-bold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                              Addition
                            </span>
                          </label>

                          <div className="flex space-x-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingItemId(null)}
                              className="px-2.5 py-1.5 border border-gray-250 text-gray-600 rounded-lg text-[10px] font-bold bg-white hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="px-3.5 py-1.5 bg-ink-700 hover:bg-ink-800 text-white rounded-lg text-[10px] font-bold shadow-sm"
                            >
                              Save Changes
                            </button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-col gap-1.5 w-full min-w-0">
                        {/* Item Description */}
                        <div className="min-w-0">
                          <div className="flex items-center flex-wrap gap-1.5">
                            <h4 className={`text-sm font-bold font-sans ${isFullyLoaded && isFullyPulled ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                              {dp.plant(item.plantName)}
                            </h4>
                            <span className={`px-1.5 py-0.5 rounded-md text-[11px] font-mono font-bold tracking-tight ${
                              isFullyLoaded ? 'bg-ink-100 text-ink-900' : isFullyPulled ? 'bg-teal-100 text-teal-900' : 'bg-gray-100 text-gray-750'
                            }`}>
                              {dp.size(item.containerSize)}
                            </span>
                            {item.isAddition && (
                              <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-amber-500 text-amber-950 border border-amber-400 shadow-sm uppercase tracking-wider animate-pulse flex items-center gap-1 shrink-0">
                                ⚠️ Addition
                              </span>
                            )}
                            
                            {permissions.canEditOrders && (
                            <div className="flex items-center space-x-1 ml-auto shrink-0">
                              <button
                                onClick={() => {
                                  setEditingItemId(item.id);
                                  setEditPlantName(item.plantName);
                                  setEditContainerSize(item.containerSize);
                                  setEditQuantity(item.quantity);
                                  setEditNotes(item.notes || '');
                                  setEditIsAddition(!!item.isAddition);
                                }}
                                className="p-1 text-gray-400 hover:text-ink-700 hover:bg-ink-50 rounded transition-colors"
                                title={t('loader.editItem')}
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                title={t('loader.deleteItem')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            )}
                          </div>
                          
                          {/* Notes & Weight Specs — keep off the pulled/loaded boxes */}
                          <div className="flex flex-col gap-1 mt-1">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                            {item.notes && (
                              <span className="text-amber-800 bg-amber-50 border border-amber-100/50 px-1.5 py-0.5 rounded font-medium">
                                {t('loader.notePrefix', { text: item.notes })}
                              </span>
                            )}
                            <span className="font-mono shrink-0">Unit Wt: {unitWeight} lbs</span>
                            <span className="font-mono font-bold text-gray-700 shrink-0">Total: {itemTotalWeight.toLocaleString()} lbs</span>
                            </div>

                            {permissions.canEditCost && (
                              <span
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 bg-indigo-50/70 text-indigo-800 font-semibold w-fit"
                                  onClick={(e) => e.stopPropagation()}
                                  title={t('loader.costHint')}
                                >
                                  <span className="text-[10px] uppercase tracking-wide">{t('loader.cost')}</span>
                                  <span className="text-[10px] font-mono">$</span>
                                  <input
                                    key={`cost-${item.id}-${item.unitCost ?? ''}`}
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    defaultValue={item.unitCost ?? ''}
                                    placeholder="0.00"
                                    onBlur={(e) => handleCostSave(item.id, e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                    }}
                                    className="w-16 bg-white border border-indigo-200 focus:border-indigo-500 focus:outline-none rounded px-1 py-0.5 text-xs font-mono font-bold text-right text-indigo-800"
                                  />
                                </span>
                            )}
                          </div>

                          {/* Vendor — own row so it stays visible on mobile */}
                          {permissions.canUseVendors && (
                            <div className="mt-1.5 w-full" onClick={(e) => e.stopPropagation()}>
                              {editingVendorItemId === item.id ? (
                                <div className="flex items-center gap-1.5 w-full animate-fade-in">
                                  <input
                                    type="text"
                                    list="vendors-list-loader"
                                    value={tempVendorName}
                                    onChange={(e) => setTempVendorName(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleVendorSave(item.id, tempVendorName);
                                      } else if (e.key === 'Escape') {
                                        setEditingVendorItemId(null);
                                      }
                                    }}
                                    autoFocus
                                    placeholder={t('loader.vendorPlaceholder')}
                                    className="flex-1 min-w-0 px-2.5 py-2 border border-ink-400 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-ink-500 bg-white font-semibold text-gray-855"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleVendorSave(item.id, tempVendorName)}
                                    className="shrink-0 px-3 py-2 bg-ink-600 hover:bg-ink-700 text-white rounded-lg text-xs font-bold transition-all shadow-sm"
                                    title="Save"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingVendorItemId(null)}
                                    className="shrink-0 px-2.5 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-xs font-bold transition-all"
                                    title="Cancel"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingVendorItemId(item.id);
                                    setTempVendorName(item.vendor || '');
                                  }}
                                  className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-all touch-manipulation ${
                                    item.vendor
                                      ? 'bg-indigo-50 border-indigo-200 text-indigo-800 hover:bg-indigo-100'
                                      : 'bg-slate-50 border-slate-300 text-slate-700 border-dashed hover:border-ink-400 hover:bg-ink-50'
                                  }`}
                                >
                                  <Building className="h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    {item.vendor
                                      ? t('loader.vendorLabel', { name: item.vendor })
                                      : t('loader.assignVendor')}
                                  </span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Twin Checkboxes / Progress Controls */}
                        <div className="grid grid-cols-2 gap-2 w-full min-w-0 border-t border-gray-100 pt-2 sm:flex sm:w-auto sm:ml-auto sm:border-0 sm:pt-0">
                          {/* Delivered / Pulled Box */}
                          <div className="flex flex-col items-center bg-teal-50/30 border border-teal-500/20 rounded-lg p-1.5 min-w-0 sm:min-w-[10.5rem] sm:shrink-0">
                            <label className="text-[9px] font-black text-teal-800 uppercase tracking-wider mb-1 cursor-pointer select-none">
                              {t('loader.pulled')}
                            </label>
                            <input
                              type="checkbox"
                              checked={isFullyPulled}
                              onChange={() => handleMarkItemFullyPulled(item.id)}
                              disabled={!permissions.canCheckOffLoading}
                              className="h-7 w-7 sm:h-6 sm:w-6 rounded-md border-2 border-teal-300 text-teal-600 focus:ring-teal-500 cursor-pointer mb-1 disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                              title={isFullyPulled ? t('loader.undoPulled') : t('loader.markAllPulled')}
                              aria-label={isFullyPulled ? t('loader.undoPulled') : t('loader.markAllPulled')}
                            />
                            <div className="flex items-center space-x-1 bg-white border border-teal-150 rounded-lg p-0.5 shadow-sm w-full justify-center">
                              <button
                                onClick={() => handlePulledQuantityChange(item.id, false)}
                                disabled={(item.pulledQuantity ?? 0) === 0 || !permissions.canCheckOffLoading}
                                className="p-2 sm:p-1 rounded text-teal-600 hover:text-teal-800 hover:bg-teal-50 disabled:opacity-30 transition-all touch-manipulation min-h-10 min-w-10 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                              </button>
                              <span className="text-[11px] font-mono font-bold text-gray-900 w-11 text-center select-none">
                                {item.pulledQuantity ?? 0} <span className="text-gray-400">/ {item.quantity}</span>
                              </span>
                              <button
                                onClick={() => handlePulledQuantityChange(item.id, true)}
                                disabled={(item.pulledQuantity ?? 0) === item.quantity || !permissions.canCheckOffLoading}
                                className="p-2 sm:p-1 rounded text-teal-600 hover:text-teal-800 hover:bg-teal-50 disabled:opacity-30 transition-all touch-manipulation min-h-10 min-w-10 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Loaded Box */}
                          <div className="flex flex-col items-center bg-ink-50/30 border border-ink-500/20 rounded-lg p-1.5 min-w-0 sm:min-w-[10.5rem] sm:shrink-0">
                            <label className="text-[9px] font-black text-ink-800 uppercase tracking-wider mb-1 cursor-pointer select-none">
                              {t('loader.loaded')}
                            </label>
                            <input
                              type="checkbox"
                              checked={isFullyLoaded}
                              onChange={() => handleMarkItemFullyLoaded(item.id)}
                              disabled={!permissions.canCheckOffLoading}
                              className="h-7 w-7 sm:h-6 sm:w-6 rounded-md border-2 border-ink-300 text-ink-600 focus:ring-ink-500 cursor-pointer mb-1 disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                              title={isFullyLoaded ? t('loader.undoLoaded') : t('loader.markAllLoaded')}
                              aria-label={isFullyLoaded ? t('loader.undoLoaded') : t('loader.markAllLoaded')}
                            />
                            <div className="flex items-center space-x-1 bg-white border border-ink-150 rounded-lg p-0.5 shadow-sm w-full justify-center">
                              <button
                                onClick={() => handleQuantityChange(item.id, false)}
                                disabled={item.loadedQuantity === 0 || !permissions.canCheckOffLoading}
                                className="p-2 sm:p-1 rounded text-ink-600 hover:text-ink-800 hover:bg-ink-50 disabled:opacity-30 transition-all touch-manipulation min-h-10 min-w-10 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                              </button>
                              <span className="text-[11px] font-mono font-bold text-gray-900 w-11 text-center select-none">
                                {item.loadedQuantity} <span className="text-gray-400">/ {item.quantity}</span>
                              </span>
                              <button
                                onClick={() => handleQuantityChange(item.id, true)}
                                disabled={item.loadedQuantity === item.quantity || !permissions.canCheckOffLoading}
                                className="p-2 sm:p-1 rounded text-ink-600 hover:text-ink-800 hover:bg-ink-50 disabled:opacity-30 transition-all touch-manipulation min-h-10 min-w-10 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="bg-gray-50 border border-gray-150 rounded-2xl p-5 relative min-h-[300px]">
            {/* Action Bar */}
            <div className="absolute top-3 right-3 z-10">
              <button
                onClick={handleCopyText}
                className="bg-white hover:bg-gray-50 border border-gray-200 shadow-sm rounded-lg px-2.5 py-1.5 text-xs font-bold text-gray-700 flex items-center space-x-1.5 transition-all"
              >
                {copied ? (
                  <>
                    <ClipboardCheck className="h-3.5 w-3.5 text-ink-600" />
                    <span className="text-ink-700">{t('common.copied')}</span>
                  </>
                ) : (
                  <>
                    <Clipboard className="h-3.5 w-3.5" />
                    <span>{t('loader.copyText')}</span>
                  </>
                )}
              </button>
            </div>

            {/* Markdown/Raw Text output */}
            <div className="whitespace-pre-wrap font-mono text-xs text-gray-800 leading-relaxed max-h-[500px] overflow-y-auto pr-2">
              {order.originalText || 'No text extracted.'}
              {order.items.some(i => i.isAddition) && (
                <div className="mt-6 pt-4 border-t border-dashed border-gray-300">
                  <div className="font-bold text-amber-700 text-sm mb-2">⚠️ LATE ADDITIONS / ADD-ONS:</div>
                  {order.items.filter(i => i.isAddition).map(i => (
                    <div key={i.id} className="text-amber-900 bg-amber-50/60 p-2 rounded border border-amber-200/50 mb-1.5">
                      • {dp.plant(i.plantName)} ({dp.size(i.containerSize)}) × {i.quantity}{' '}
                      {i.notes ? `[${t('loader.notePrefix', { text: i.notes })}]` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5 pt-3.5 border-t border-gray-200 flex flex-col sm:flex-row justify-between items-start sm:items-center text-xs text-gray-500 gap-2">
              <span className="flex items-center">
                <Info className="h-3.5 w-3.5 mr-1 text-ink-700" />
                This document layout is auto-generated by NurseryOS
              </span>
              <span className="font-mono font-bold">
                {t('loader.estimatedWeight', { weight: totalWeight.toLocaleString() })}
              </span>
            </div>
          </div>
        )}
      </div>

      <datalist id="vendors-list-loader">
        {permissions.canUseVendors &&
          DEFAULT_VENDORS.map((vendor) => (
            <option key={vendor} value={vendor} />
          ))}
      </datalist>

      {permissions.canViewInvoices && (
      <InvoiceModal
        isOpen={isInvoiceOpen}
        onClose={() => setIsInvoiceOpen(false)}
        order={order}
        documentType={documentType}
        customer={
          customers.find((c) => c.id === order.customerId) ||
          customers.find(
            (c) => c.name.trim().toLowerCase() === order.customerName.trim().toLowerCase()
          ) ||
          null
        }
        truckOrders={
          order.truckId
            ? orders.filter((candidate) => candidate.truckId === order.truckId)
            : []
        }
        nurseryName={nurseryName}
        nurseryAddress={nurseryAddress}
        nurseryLogoSrc={nurseryLogoSrc}
        tenantId={tenantId}
        canViewProfit={permissions.canViewProfit}
        canCollectPayments={permissions.canCollectPayments}
        canUseQuickbooks={permissions.canUseQuickbooks}
      />
      )}

      {permissions.canCheckOffLoading && activeTab === 'checklist' && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-ink-200 bg-white/95 backdrop-blur px-4 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.08)] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-wide text-ink-800">{t('loader.checkoff')}</p>
              <p className="text-xs font-bold text-gray-900 truncate">
                {t('loader.pullLoadLeft', { pull: remainingToPull, load: remainingToLoad })}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-mono font-bold text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-2 py-1">
                {pulledQuantity}/{totalQuantity}
              </span>
              <span className="text-[11px] font-mono font-bold text-ink-800 bg-ink-50 border border-ink-100 rounded-lg px-2 py-1">
                {loadedQuantity}/{totalQuantity}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
