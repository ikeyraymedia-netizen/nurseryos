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
import {
  updateOrderItemProgress,
  updateOrderItemPulledProgress,
  updateOrderItemVendor,
  markAllItemsAsLoaded,
  resetOrderProgress,
  updateCustomerOrder
} from '../lib/db';
import { notifyInventorySyncIssue } from '../lib/inventory';
import { orderNeedsInvoiceSave } from '../lib/invoicing';
import { listAllDocuments } from '../lib/documents';
import { DEFAULT_VENDORS } from '../data/vendors';
import { InvoiceModal } from './InvoiceModal';

interface LoaderWorkspaceProps {
  order: CustomerOrder;
  orders?: CustomerOrder[];
  containerWeights: ContainerWeight[];
  customers: Customer[];
  permissions: AppPermissions;
  nurseryName?: string;
  tenantId?: string;
}

export const LoaderWorkspace: React.FC<LoaderWorkspaceProps> = ({
  order,
  orders = [],
  containerWeights,
  customers,
  permissions,
  nurseryName = 'NurseryOS',
  tenantId
}) => {
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

  const [stagedLocation, setStagedLocation] = useState(order.stagedLocation || '');
  const [savingStagedLocation, setSavingStagedLocation] = useState(false);
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
      setAddError('Plant name is required');
      return;
    }
    if (!newContainerSize) {
      setAddError('Container size is required');
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
        vendor: newVendorName.trim() || undefined,
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
      setAddError(err.message || 'Failed to add plant to order');
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
    <div id="loader-workspace-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-emerald-700 border-x border-b border-slate-200/95 p-6 flex flex-col h-full relative pb-24 sm:pb-6">
      
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-5 mb-5 gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-950 border border-emerald-300 font-mono">
              ORDER IN WORKSPACE
            </span>
            <span className="text-xs text-slate-500 font-mono font-bold">ID: {order.id.slice(0, 6)}</span>
          </div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight font-sans mt-1">
            {order.customerName}
          </h2>
          <p className="text-sm text-slate-600 font-mono flex items-center mt-0.5">
            <Building className="h-4 w-4 mr-1 text-slate-500" /> Invoice / Order #: <span className="font-bold text-gray-700 ml-1">{order.orderNumber}</span>
          </p>
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
                <span>Create Estimate</span>
              </button>
              <button
                onClick={() => {
                  setDocumentType('invoice');
                  setIsInvoiceOpen(true);
                }}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center space-x-1"
              >
                <DollarSign className="h-3.5 w-3.5" />
                <span>Create Invoice</span>
              </button>
            </>
          )}

          {permissions.canEditOrders && showResetConfirm ? (
            <div className="flex items-center bg-amber-50 border border-amber-200 rounded-lg p-1 space-x-1">
              <span className="text-[10px] font-bold text-amber-800 px-1">Reset counts?</span>
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
            <div className="flex items-center bg-emerald-50 border border-emerald-200 rounded-lg p-1 space-x-1">
              <span className="text-[10px] font-bold text-emerald-800 px-1">Load all plants?</span>
              <button
                onClick={handleLoadAll}
                className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-[10px] rounded"
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
                  <span>Reset Truck</span>
                </button>
              )}
              {permissions.canCheckOffLoading && (
                <button
                  onClick={() => setShowLoadAllConfirm(true)}
                  disabled={loadedQuantity === totalQuantity}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center space-x-1 disabled:opacity-40 disabled:pointer-events-none"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Load All</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {permissions.canViewInvoices && needsInvoiceSave && (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5">
          <p className="text-xs text-amber-950 leading-relaxed">
            <span className="font-black">Invoice not saved to customer.</span> Pricing is on this order,
            but Reports won&apos;t count it as sales until you open Create Invoice and tap{' '}
            <span className="font-bold">Save to Customer</span>.
          </p>
          <button
            type="button"
            onClick={() => {
              setDocumentType('invoice');
              setIsInvoiceOpen(true);
            }}
            className="inline-flex items-center justify-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-bold"
          >
            <DollarSign className="h-3.5 w-3.5" />
            Save invoice
          </button>
        </div>
      )}

      {/* Staging Location Card */}
      <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-4 mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center space-x-3 shrink-0">
          <div className="bg-emerald-100 text-emerald-800 p-2 rounded-xl border border-emerald-200 shadow-sm">
            <MapPin className="h-5 w-5" />
          </div>
          <div>
            <h4 className="text-xs font-black text-gray-800 uppercase tracking-wider font-mono">Order Staging Location</h4>
            <p className="text-xs text-slate-500 font-medium mt-0.5">Where this plant order is staged out in the yard</p>
          </div>
        </div>
        
        <div className="flex-1 max-w-md relative">
          <input
            type="text"
            placeholder="Type staging area (e.g. Dock A, Greenhouse #3, Bay 5)..."
            value={stagedLocation}
            readOnly={!permissions.canEditOrders}
            onChange={(e) => permissions.canEditOrders && handleStagedLocationChange(e.target.value)}
            className="block w-full px-4 py-2 bg-white border border-slate-300 rounded-xl text-sm font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-600 transition-all shadow-inner disabled:bg-slate-100"
          />
          {savingStagedLocation && (
            <div className="absolute right-3 top-2.5 flex items-center space-x-1.5 bg-emerald-50 border border-emerald-150 px-2 py-0.5 rounded-lg">
              <span className="w-1.5 h-1.5 bg-emerald-600 rounded-full animate-ping" />
              <span className="text-[10px] font-bold text-emerald-700 font-mono">SAVING...</span>
            </div>
          )}
        </div>
      </div>

      {permissions.canEditOrders && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 mb-5">
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Assigned Customer</label>
          <select
            value={order.customerId || ''}
            onChange={(e) => handleAssignCustomer(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
          >
            <option value="">Unassigned</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Weight Summary Panel */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-emerald-50/75 border border-emerald-300 rounded-2xl p-4 mb-5 shadow-sm">
        
        {/* Total Weight Stat */}
        <div className="flex items-center space-x-3.5">
          <div className="bg-emerald-700/10 p-2.5 rounded-xl text-emerald-800 shrink-0 border border-emerald-700/20">
            <Weight className="h-5.5 w-5.5" />
          </div>
          <div>
            <p className="text-xs font-bold text-emerald-800/80 uppercase tracking-wide font-mono">Total Order Weight</p>
            <p className="text-2xl font-black text-gray-900 font-mono tracking-tight">
              {totalWeight.toLocaleString()} <span className="text-xs font-semibold text-gray-500">lbs</span>
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5 leading-none">Sum of all loaded/pending plants</p>
          </div>
        </div>

        {/* Delivered / Pulled Progress Stat */}
        <div>
          <div className="flex justify-between items-baseline mb-1">
            <p className="text-xs font-bold text-emerald-800/80 uppercase tracking-wide font-mono font-bold">Delivered/Pulled</p>
            <p className="text-xs font-bold font-mono text-emerald-800">
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
            Pulled <span className="font-bold text-gray-900">{pulledQuantity}</span> of <span className="font-bold text-gray-900">{totalQuantity}</span> plants ({totalQuantity > 0 ? Math.round((pulledQuantity / totalQuantity) * 100) : 0}% pulled from nursery)
          </p>
        </div>

        {/* Loading Progress Stat */}
        <div>
          <div className="flex justify-between items-baseline mb-1">
            <p className="text-xs font-bold text-emerald-800/80 uppercase tracking-wide font-mono">On-Truck Progress</p>
            <p className="text-xs font-bold font-mono text-emerald-800">
              {loadedWeight.toLocaleString()} / {totalWeight.toLocaleString()} lbs
            </p>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-gray-200 h-2.5 rounded-full overflow-hidden mb-1 border border-gray-100">
            <div
              className="bg-emerald-700 h-full rounded-full transition-all duration-300"
              style={{ width: `${totalWeight > 0 ? (loadedWeight / totalWeight) * 100 : 0}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-500 font-medium">
            Loaded <span className="font-bold text-gray-900">{loadedQuantity}</span> of <span className="font-bold text-gray-900">{totalQuantity}</span> plants ({totalQuantity > 0 ? Math.round((loadedQuantity / totalQuantity) * 100) : 0}% items on truck)
          </p>
        </div>

      </div>

      {/* View Switcher Tabs */}
      <div className="flex border-b border-gray-100 mb-5">
        <button
          onClick={() => setActiveTab('checklist')}
          className={`flex items-center space-x-2 px-4 py-2.5 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'checklist'
              ? 'border-emerald-700 text-emerald-800 bg-emerald-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <ListTodo className="h-4.5 w-4.5" />
          <span>Interactive Loader List</span>
        </button>
        <button
          onClick={() => setActiveTab('plaintext')}
          className={`flex items-center space-x-2 px-4 py-2.5 border-b-2 text-sm font-bold transition-all ${
            activeTab === 'plaintext'
              ? 'border-emerald-700 text-emerald-800 bg-emerald-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <FileText className="h-4.5 w-4.5" />
          <span>Extracted Plain Text</span>
        </button>
      </div>

      {/* Workspace Body */}
      <div className="flex-1 overflow-y-auto min-h-[300px]">
        {activeTab === 'checklist' ? (
          <div className="space-y-3 pr-1">
            {/* Quick Add Plant Action */}
            {permissions.canEditOrders && (
              !isAddingPlant ? (
              <button
                type="button"
                onClick={() => setIsAddingPlant(true)}
                className="w-full py-3 px-4 border border-dashed border-emerald-300 hover:border-emerald-500 bg-emerald-50/20 hover:bg-emerald-50/50 text-emerald-800 hover:text-emerald-900 font-bold text-sm rounded-xl transition-all flex items-center justify-center space-x-2 shadow-sm mb-4"
              >
                <Plus className="h-4.5 w-4.5 stroke-[2.5px]" />
                <span>Add Plant / Item to this Order</span>
              </button>
            ) : (
              <form
                onSubmit={handleAddPlantSubmit}
                className="bg-white border-2 border-emerald-500 rounded-xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in"
              >
                <div className="flex items-center justify-between border-b border-gray-100 pb-2">
                  <h4 className="text-sm font-bold text-gray-900 flex items-center">
                    <Plus className="h-4 w-4 mr-1 text-emerald-700" />
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
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
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
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      required
                    >
                      <option value="">Select Size...</option>
                      {containerWeights.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({w.weightLbs} lbs)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Quantity *
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={newQuantity}
                      onChange={(e) => setNewQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-mono font-bold text-gray-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Assign Vendor (Optional)
                    </label>
                    <input
                      type="text"
                      list="vendors-list-loader"
                      placeholder="Type or select vendor..."
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Optional Notes
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Late addition / Tag-along"
                      value={newNotes}
                      onChange={(e) => setNewNotes(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <label className="flex items-center space-x-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={newIsAddition}
                      onChange={(e) => setNewIsAddition(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-350 text-emerald-700 focus:ring-emerald-500 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-amber-800 bg-amber-50 px-2 py-1 rounded border border-amber-200 flex items-center space-x-1">
                      <span>⚠️ Mark as addition (notifies loaders)</span>
                    </span>
                  </label>

                  <button
                    type="submit"
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs rounded-lg shadow-sm transition-all flex items-center space-x-1"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>Save Plant to Order</span>
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
                    className={`border-2 rounded-xl p-3.5 transition-all shadow-sm ${
                      isEditing
                        ? 'border-emerald-600 bg-slate-50'
                        : isFullyLoaded && isFullyPulled
                        ? 'border-emerald-600 bg-emerald-50/30'
                        : isFullyLoaded
                        ? 'border-emerald-500/50 bg-emerald-50/15'
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
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
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
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
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
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white font-mono font-bold text-gray-800"
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
                              className="block w-full px-2.5 py-1.5 border border-gray-250 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
                              placeholder="Optional notes"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-gray-200">
                          <label className="flex items-center space-x-1.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={editIsAddition}
                              onChange={(e) => setEditIsAddition(e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-700 focus:ring-emerald-500 cursor-pointer"
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
                              className="px-3.5 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-[10px] font-bold shadow-sm"
                            >
                              Save Changes
                            </button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 w-full">
                        {/* Item Description */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center flex-wrap gap-2">
                            <h4 className={`text-base font-bold font-sans ${isFullyLoaded && isFullyPulled ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                              {item.plantName}
                            </h4>
                            <span className={`px-2 py-0.5 rounded-md text-xs font-mono font-bold tracking-tight ${
                              isFullyLoaded ? 'bg-emerald-100 text-emerald-900' : isFullyPulled ? 'bg-teal-100 text-teal-900' : 'bg-gray-100 text-gray-750'
                            }`}>
                              {item.containerSize}
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
                                className="p-1 text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 rounded transition-colors"
                                title="Edit item details"
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                title="Delete item"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            )}
                          </div>
                          
                          {/* Notes & Weight Specs */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500">
                            {item.notes && (
                              <span className="text-amber-800 bg-amber-50 border border-amber-100/50 px-1.5 py-0.5 rounded font-medium">
                                Note: {item.notes}
                              </span>
                            )}
                            <span className="font-mono">Unit Wt: {unitWeight} lbs</span>
                            <span className="font-mono font-bold text-gray-700">Total: {itemTotalWeight.toLocaleString()} lbs</span>
                            
                            <span className="text-gray-300">|</span>
                            
                            {/* Vendor Section */}
                            {permissions.canEditOrders ? (
                            editingVendorItemId === item.id ? (
                              <div className="flex items-center space-x-1 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                                <div className="relative">
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
                                    placeholder="Type or select vendor..."
                                    className="px-2 py-0.5 border border-emerald-400 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 bg-white font-semibold text-gray-855 w-44"
                                  />
                                </div>
                                <button
                                  onClick={() => handleVendorSave(item.id, tempVendorName)}
                                  className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-[10px] font-bold transition-all shadow-sm"
                                  title="Save"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingVendorItemId(null)}
                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-md text-[10px] font-bold transition-all"
                                  title="Cancel"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setEditingVendorItemId(item.id);
                                  setTempVendorName(item.vendor || '');
                                }}
                                className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-xs font-semibold border transition-all ${
                                  item.vendor
                                    ? 'bg-indigo-50 border-indigo-200 text-indigo-800 hover:bg-indigo-100'
                                    : 'bg-slate-50 border-slate-200 text-slate-500 border-dashed hover:border-slate-350 hover:bg-slate-100'
                                }`}
                              >
                                <Building className="h-3.5 w-3.5 shrink-0" />
                                <span>{item.vendor ? `Vendor: ${item.vendor}` : '+ Assign Vendor'}</span>
                              </button>
                            )
                            ) : item.vendor ? (
                              <span className="text-xs text-indigo-700 font-semibold">Vendor: {item.vendor}</span>
                            ) : null}
                          </div>
                        </div>

                        {/* Twin Checkboxes / Progress Controls */}
                        <div className="grid grid-cols-2 gap-3 w-full border-t lg:border-t-0 pt-3 lg:pt-0">
                          {/* Delivered / Pulled Box */}
                          <div className="flex flex-col items-center bg-teal-50/30 border border-teal-500/20 rounded-xl p-2.5">
                            <label className="text-[10px] font-black text-teal-800 uppercase tracking-wider mb-1.5 cursor-pointer select-none">
                              Pulled
                            </label>
                            <input
                              type="checkbox"
                              checked={isFullyPulled}
                              onChange={() => handleMarkItemFullyPulled(item.id)}
                              disabled={!permissions.canCheckOffLoading}
                              className="h-8 w-8 sm:h-7 sm:w-7 rounded-md border-2 border-teal-300 text-teal-600 focus:ring-teal-500 cursor-pointer mb-2 disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                              title={isFullyPulled ? 'Undo pulled' : 'Mark all pulled'}
                              aria-label={isFullyPulled ? 'Undo pulled' : 'Mark all pulled'}
                            />
                            <div className="flex items-center space-x-1.5 bg-white border border-teal-150 rounded-lg p-0.5 shadow-sm w-full justify-center">
                              <button
                                onClick={() => handlePulledQuantityChange(item.id, false)}
                                disabled={(item.pulledQuantity ?? 0) === 0 || !permissions.canCheckOffLoading}
                                className="p-2.5 sm:p-1.5 rounded text-teal-600 hover:text-teal-800 hover:bg-teal-50 disabled:opacity-30 transition-all touch-manipulation min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Minus className="h-5 w-5 sm:h-4 sm:w-4" />
                              </button>
                              <span className="text-xs font-mono font-bold text-gray-900 w-11 text-center select-none">
                                {item.pulledQuantity ?? 0} <span className="text-gray-400">/ {item.quantity}</span>
                              </span>
                              <button
                                onClick={() => handlePulledQuantityChange(item.id, true)}
                                disabled={(item.pulledQuantity ?? 0) === item.quantity || !permissions.canCheckOffLoading}
                                className="p-2.5 sm:p-1.5 rounded text-teal-600 hover:text-teal-800 hover:bg-teal-50 disabled:opacity-30 transition-all touch-manipulation min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Plus className="h-5 w-5 sm:h-4 sm:w-4" />
                              </button>
                            </div>
                          </div>

                          {/* Loaded Box */}
                          <div className="flex flex-col items-center bg-emerald-50/30 border border-emerald-500/20 rounded-xl p-2.5">
                            <label className="text-[10px] font-black text-emerald-800 uppercase tracking-wider mb-1.5 cursor-pointer select-none">
                              Loaded
                            </label>
                            <input
                              type="checkbox"
                              checked={isFullyLoaded}
                              onChange={() => handleMarkItemFullyLoaded(item.id)}
                              disabled={!permissions.canCheckOffLoading}
                              className="h-8 w-8 sm:h-7 sm:w-7 rounded-md border-2 border-emerald-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer mb-2 disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                              title={isFullyLoaded ? 'Undo loaded' : 'Mark all loaded'}
                              aria-label={isFullyLoaded ? 'Undo loaded' : 'Mark all loaded'}
                            />
                            <div className="flex items-center space-x-1.5 bg-white border border-emerald-150 rounded-lg p-0.5 shadow-sm w-full justify-center">
                              <button
                                onClick={() => handleQuantityChange(item.id, false)}
                                disabled={item.loadedQuantity === 0 || !permissions.canCheckOffLoading}
                                className="p-2.5 sm:p-1.5 rounded text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 disabled:opacity-30 transition-all touch-manipulation min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Minus className="h-5 w-5 sm:h-4 sm:w-4" />
                              </button>
                              <span className="text-xs font-mono font-bold text-gray-900 w-11 text-center select-none">
                                {item.loadedQuantity} <span className="text-gray-400">/ {item.quantity}</span>
                              </span>
                              <button
                                onClick={() => handleQuantityChange(item.id, true)}
                                disabled={item.loadedQuantity === item.quantity || !permissions.canCheckOffLoading}
                                className="p-2.5 sm:p-1.5 rounded text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 disabled:opacity-30 transition-all touch-manipulation min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                              >
                                <Plus className="h-5 w-5 sm:h-4 sm:w-4" />
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
                    <ClipboardCheck className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="text-emerald-700">Copied!</span>
                  </>
                ) : (
                  <>
                    <Clipboard className="h-3.5 w-3.5" />
                    <span>Copy Text</span>
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
                      • {i.quantity} x {i.plantName} ({i.containerSize}) {i.notes ? `[Note: ${i.notes}]` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5 pt-3.5 border-t border-gray-200 flex flex-col sm:flex-row justify-between items-start sm:items-center text-xs text-gray-500 gap-2">
              <span className="flex items-center">
                <Info className="h-3.5 w-3.5 mr-1 text-emerald-700" />
                This document layout is auto-generated by NurseryOS
              </span>
              <span className="font-mono font-bold">
                ESTIMATED SHIPPING WEIGHT: {totalWeight.toLocaleString()} LBS
              </span>
            </div>
          </div>
        )}
      </div>

      <datalist id="vendors-list-loader">
        {DEFAULT_VENDORS.map((vendor) => (
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
        tenantId={tenantId}
      />
      )}

      {permissions.canCheckOffLoading && activeTab === 'checklist' && (
        <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-emerald-200 bg-white/95 backdrop-blur px-4 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.08)] pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-wide text-emerald-800">Checkoff</p>
              <p className="text-xs font-bold text-gray-900 truncate">
                Pull {remainingToPull} · Load {remainingToLoad} left
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-mono font-bold text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-2 py-1">
                {pulledQuantity}/{totalQuantity}
              </span>
              <span className="text-[11px] font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1">
                {loadedQuantity}/{totalQuantity}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
