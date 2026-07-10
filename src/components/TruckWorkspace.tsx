import React, { useState } from 'react';
import { CustomerOrder, Truck, ContainerWeight, Customer } from '../types';
import { AppPermissions } from '../lib/permissions';
import { notifyInventorySyncIssue } from '../lib/inventory';
import {
  updateOrderItemProgress,
  updateOrderItemPulledProgress,
  markAllItemsAsLoaded,
  resetOrderProgress,
  updateCustomerOrder,
  addCustomerOrder,
  updateTruck
} from '../lib/db';
import { getTruckWeightCapacity, calculateWeightPercentage } from '../lib/capacity';
import { 
  Truck as TruckIcon, 
  Weight, 
  Calendar, 
  CheckCircle2, 
  PlayCircle, 
  CircleDot, 
  Edit, 
  ArrowLeft, 
  ChevronDown, 
  ChevronUp, 
  Info,
  Package,
  User,
  ExternalLink,
  RotateCcw,
  CheckCheck,
  FileText,
  Plus,
  AlertCircle,
  MapPin,
  Trash2,
  Mail
} from 'lucide-react';
import { BillOfLadingModal } from './BillOfLadingModal';
import { InvoiceModal } from './InvoiceModal';

interface TruckWorkspaceProps {
  truck: Truck;
  orders: CustomerOrder[];
  containerWeights: ContainerWeight[];
  permissions: AppPermissions;
  customers?: Customer[];
  nurseryName?: string;
  onEditTruck: () => void;
  onSelectOrder: (orderId: string) => void;
}

export const TruckWorkspace: React.FC<TruckWorkspaceProps> = ({
  truck,
  orders,
  containerWeights,
  permissions,
  customers = [],
  nurseryName = 'NurseryOS',
  onEditTruck,
  onSelectOrder
}) => {
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [isBOLOpen, setIsBOLOpen] = useState(false);
  const [resettingOrderId, setResettingOrderId] = useState<string | null>(null);
  const [invoiceOrder, setInvoiceOrder] = useState<CustomerOrder | null>(null);
  const [showInvoiceMenu, setShowInvoiceMenu] = useState(false);

  function openInvoice(order: CustomerOrder) {
    setShowInvoiceMenu(false);
    setInvoiceOrder(order);
  }

  // States for adding a plant to an existing order in this truck
  const [addingPlantToOrderId, setAddingPlantToOrderId] = useState<string | null>(null);
  const [newPlantName, setNewPlantName] = useState('');
  const [newContainerSize, setNewContainerSize] = useState('');
  const [newQuantity, setNewQuantity] = useState(1);
  const [newIsAddition, setNewIsAddition] = useState(true);
  const [newNotes, setNewNotes] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // States for editing an item inside an order in this truck
  const [editingItemId, setEditingItemId] = useState<string | null>(null); // format: orderId-itemId
  const [editPlantName, setEditPlantName] = useState('');
  const [editContainerSize, setEditContainerSize] = useState('');
  const [editQuantity, setEditQuantity] = useState(1);
  const [editNotes, setEditNotes] = useState('');
  const [editIsAddition, setEditIsAddition] = useState(false);

  // States for creating a brand new standalone customer addition to this truck
  const [isCreatingStandalone, setIsCreatingStandalone] = useState(false);
  const [standaloneCustomerName, setStandaloneCustomerName] = useState('');
  const [standaloneOrderNumber, setStandaloneOrderNumber] = useState('');
  const [standalonePlantName, setStandalonePlantName] = useState('');
  const [standaloneContainerSize, setStandaloneContainerSize] = useState('');
  const [standaloneQuantity, setStandaloneQuantity] = useState(1);
  const [standaloneNotes, setStandaloneNotes] = useState('');
  const [standaloneError, setStandaloneError] = useState<string | null>(null);

  // Filter orders belonging to this truck, sorted by their designated loading sequence
  const truckOrders = orders
    .filter((o) => truck.orderIds.includes(o.id) || o.truckId === truck.id)
    .sort((a, b) => {
      const idxA = truck.orderIds.indexOf(a.id);
      const idxB = truck.orderIds.indexOf(b.id);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

  // Fallback to auto-open first order if none expanded
  const handleToggleOrderExpansion = (orderId: string) => {
    setExpandedOrderId(expandedOrderId === orderId ? null : orderId);
  };

  // Compute overall stats
  let totalPlants = 0;
  let loadedPlants = 0;
  let totalWeight = 0;

  truckOrders.forEach((o) => {
    totalWeight += o.totalWeightLbs;
    o.items.forEach((item) => {
      totalPlants += item.quantity;
      loadedPlants += item.loadedQuantity;
    });
  });

  const overallPercentage = totalPlants > 0 ? Math.round((loadedPlants / totalPlants) * 100) : 0;

  // Truck weight limits calculations
  const capacity = getTruckWeightCapacity(truck.truckType);
  const overallWeightPercentage = calculateWeightPercentage(totalWeight, truck.truckType);

  // Handlers for adjusting plant loading increments inside an individual order
  const handleQuantityAdjust = async (
    orderId: string, 
    order: CustomerOrder, 
    itemId: string, 
    newQty: number
  ) => {
    if (newQty < 0) return;
    const item = order.items.find(i => i.id === itemId);
    if (!item) return;
    if (newQty > item.quantity) return;

    setUpdatingItemId(`${orderId}-${itemId}`);
    try {
      const note = await updateOrderItemProgress(
        orderId,
        itemId,
        newQty,
        order.items,
        order.items.length
      );
      notifyInventorySyncIssue(note);
    } catch (err) {
      console.error('Failed to update plant load progress:', err);
    } finally {
      setUpdatingItemId(null);
    }
  };

  const handleMarkOrderLoaded = async (order: CustomerOrder) => {
    try {
      const note = await markAllItemsAsLoaded(order.id, order.items);
      notifyInventorySyncIssue(note);
    } catch (err) {
      console.error('Failed to mark order loaded:', err);
    }
  };

  const handlePulledAdjust = async (
    orderId: string,
    order: CustomerOrder,
    itemId: string,
    newQty: number
  ) => {
    if (newQty < 0) return;
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;
    if (newQty > item.quantity) return;

    setUpdatingItemId(`${orderId}-${itemId}-pulled`);
    try {
      await updateOrderItemPulledProgress(orderId, itemId, newQty, order.items, order.items.length);
    } catch (err) {
      console.error('Failed to update pulled progress:', err);
    } finally {
      setUpdatingItemId(null);
    }
  };

  const handleMarkItemFullyLoaded = (
    orderId: string,
    order: CustomerOrder,
    itemId: string
  ) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    const isFullyLoaded = item.loadedQuantity >= item.quantity;
    const newQty = isFullyLoaded ? 0 : item.quantity;

    void updateOrderItemProgress(
      orderId,
      itemId,
      newQty,
      order.items,
      order.items.length
    )
      .then(notifyInventorySyncIssue)
      .catch((err) => console.error('Failed to mark item fully loaded:', err));
  };

  const handleMarkItemFullyPulled = (
    orderId: string,
    order: CustomerOrder,
    itemId: string
  ) => {
    const item = order.items.find((i) => i.id === itemId);
    if (!item) return;

    const isFullyPulled = (item.pulledQuantity ?? 0) >= item.quantity;
    const newQty = isFullyPulled ? 0 : item.quantity;

    void updateOrderItemPulledProgress(orderId, itemId, newQty, order.items, order.items.length).catch(
      (err) => console.error('Failed to mark item fully pulled:', err)
    );
  };

  const handleResetOrder = async (order: CustomerOrder) => {
    try {
      const note = await resetOrderProgress(order.id, order.items);
      notifyInventorySyncIssue(note);
      setResettingOrderId(null);
    } catch (err) {
      console.error('Failed to reset order:', err);
    }
  };

  const handleLoadAllTruck = async () => {
    for (const order of truckOrders) {
      const note = await markAllItemsAsLoaded(order.id, order.items);
      if (note.includes('could not') || note.includes('no matching') || note.includes('not enough')) {
        notifyInventorySyncIssue(`${order.customerName}: ${note}`);
      }
    }
  };

  const handleResetTruck = async () => {
    for (const order of truckOrders) {
      const note = await resetOrderProgress(order.id, order.items);
      if (note.includes('could not') || note.includes('no matching') || note.includes('not enough')) {
        notifyInventorySyncIssue(`${order.customerName}: ${note}`);
      }
    }
  };

  const getContainerUnitWeight = (size: string): number => {
    const match = containerWeights.find(
      (w) => w.id.toLowerCase() === size.toLowerCase() ||
             w.name.toLowerCase() === size.toLowerCase() ||
             w.label.toLowerCase() === size.toLowerCase()
    );
    return match ? match.weightLbs : 0;
  };

  const handleAddPlantToOrderSubmit = async (e: React.FormEvent, order: CustomerOrder) => {
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
        notes: newNotes.trim() || undefined,
        isAddition: newIsAddition
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

      // Compute total weight based on new items list
      const totalWeightLbs = updatedItems.reduce((total, item) => {
        return total + (getContainerUnitWeight(item.containerSize) * item.quantity);
      }, 0);

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        totalWeightLbs,
        status
      });

      // Reset form on success
      setNewPlantName('');
      setNewContainerSize('');
      setNewQuantity(1);
      setNewIsAddition(true);
      setNewNotes('');
      setAddingPlantToOrderId(null);
    } catch (err: any) {
      console.error('Error adding plant to order inside truck:', err);
      setAddError(err.message || 'Failed to add plant to order');
    }
  };

  const handleCreateStandaloneAdditionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStandaloneError(null);

    if (!standaloneCustomerName.trim()) {
      setStandaloneError('Customer/Label is required');
      return;
    }
    if (!standalonePlantName.trim()) {
      setStandaloneError('Plant name is required');
      return;
    }
    if (!standaloneContainerSize) {
      setStandaloneError('Container size is required');
      return;
    }
    if (standaloneQuantity <= 0) {
      setStandaloneError('Quantity must be at least 1');
      return;
    }

    try {
      const newItem = {
        id: `item-add-${Date.now()}`,
        plantName: standalonePlantName.trim(),
        containerSize: standaloneContainerSize,
        quantity: Number(standaloneQuantity) || 1,
        loadedQuantity: 0,
        notes: standaloneNotes.trim() || undefined,
        isAddition: true
      };

      const orderNumber = standaloneOrderNumber.trim() || `ADD-${Date.now().toString().slice(-4)}`;
      const totalWeightLbs = getContainerUnitWeight(standaloneContainerSize) * Number(standaloneQuantity);

      // Create new customer order linked to this truck
      const newOrderId = await addCustomerOrder({
        customerName: standaloneCustomerName.trim(),
        orderNumber,
        items: [newItem],
        originalText: `Standalone Addition added directly to Truck: ${truck.name}`,
        status: 'pending',
        totalWeightLbs,
        truckId: truck.id
      });

      // Update the truck's orderIds
      const updatedTruck: Truck = {
        ...truck,
        orderIds: [...(truck.orderIds || []), newOrderId]
      };
      await updateTruck(updatedTruck);

      // Reset form states
      setStandaloneCustomerName('');
      setStandaloneOrderNumber('');
      setStandalonePlantName('');
      setStandaloneContainerSize('');
      setStandaloneQuantity(1);
      setStandaloneNotes('');
      setIsCreatingStandalone(false);
    } catch (err: any) {
      console.error('Error creating standalone addition:', err);
      setStandaloneError(err.message || 'Failed to create standalone addition');
    }
  };

  const handleDeleteItem = async (order: CustomerOrder, itemId: string) => {
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

      // Compute total weight based on new items list
      const totalWeightLbs = updatedItems.reduce((total, item) => {
        return total + (getContainerUnitWeight(item.containerSize) * item.quantity);
      }, 0);

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        totalWeightLbs,
        status
      });
    } catch (err) {
      console.error('Error deleting item from order:', err);
    }
  };

  const handleSaveEditedItem = async (order: CustomerOrder, itemId: string) => {
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

      // Compute total weight based on new items list
      const totalWeightLbs = updatedItems.reduce((total, item) => {
        return total + (getContainerUnitWeight(item.containerSize) * item.quantity);
      }, 0);

      await updateCustomerOrder({
        ...order,
        items: updatedItems,
        totalWeightLbs,
        status
      });
      setEditingItemId(null);
    } catch (err) {
      console.error('Error saving edited item:', err);
    }
  };

  return (
    <div className="bg-emerald-50/50 rounded-2xl border-2 border-emerald-600/30 shadow-md overflow-hidden h-full flex flex-col">
      {/* Summary Header banner */}
      <div className="bg-emerald-950 text-white p-6 border-b border-emerald-900 relative shrink-0 lg:sticky lg:top-0 lg:z-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start space-x-3.5">
            <div className="bg-emerald-900 p-3 rounded-2xl text-emerald-100 shadow-inner">
              <TruckIcon className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-xl font-bold tracking-tight font-sans text-emerald-50">
                  {truck.name}
                </h2>
                {overallPercentage >= 100 ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono">
                    FULLY LOADED
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono animate-pulse">
                    IN PROGRESS
                  </span>
                )}
              </div>
              
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-emerald-200 font-mono">
                {truck.owner && (
                  <span className={`flex items-center font-bold px-2.5 py-0.5 rounded shadow-sm shrink-0 ${
                    truck.owner === 'Ikey' ? 'text-teal-950 bg-teal-300' :
                    truck.owner === 'Nathan' ? 'text-blue-950 bg-blue-300' :
                    'text-purple-950 bg-purple-300'
                  }`}>
                    Owner: {truck.owner}
                  </span>
                )}
                {truck.truckType && (
                  <span className="flex items-center font-bold text-white bg-emerald-800/85 px-2 py-0.5 rounded border border-emerald-700/60 shadow-sm shrink-0">
                    Type: {truck.truckType}
                  </span>
                )}
                {truck.loadingDate && (
                  <span className="flex items-center font-bold text-amber-950 bg-amber-400 px-2.5 py-0.5 rounded shadow-sm shrink-0">
                    <Calendar className="h-3.5 w-3.5 mr-1 text-amber-950 shrink-0" />
                    Loading: {new Date(truck.loadingDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
                {truck.carrier && (
                  <span className="flex items-center font-semibold shrink-0">
                    Carrier: {truck.carrier}
                  </span>
                )}
                <span className="flex items-center">
                  <Calendar className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                  Created: {new Date(truck.dateCreated).toLocaleDateString()}
                </span>
                <span className="flex items-center">
                  <Package className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                  {truckOrders.length} grouped {truckOrders.length === 1 ? 'order' : 'orders'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 self-start md:self-center">
            {permissions.canViewBOL && (
              <button
                onClick={() => setIsBOLOpen(true)}
                className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-black bg-emerald-500 hover:bg-emerald-400 text-emerald-950 transition-colors border border-emerald-400 shadow-sm font-sans"
              >
                <FileText className="h-3.5 w-3.5 mr-1.5 text-emerald-950" />
                Generate Bill of Lading
              </button>
            )}

            {permissions.canViewInvoices && truckOrders.length > 0 && (
              truckOrders.length === 1 ? (
                <button
                  type="button"
                  onClick={() => openInvoice(truckOrders[0])}
                  className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-black bg-slate-800 hover:bg-slate-900 text-white transition-colors border border-slate-700 shadow-sm"
                >
                  <Mail className="h-3.5 w-3.5 mr-1.5" />
                  Send Invoice
                </button>
              ) : (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowInvoiceMenu((open) => !open)}
                    className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-black bg-slate-800 hover:bg-slate-900 text-white transition-colors border border-slate-700 shadow-sm"
                  >
                    <Mail className="h-3.5 w-3.5 mr-1.5" />
                    Send Invoice
                    <ChevronDown className="h-3.5 w-3.5 ml-1" />
                  </button>
                  {showInvoiceMenu && (
                    <div className="absolute right-0 mt-1 min-w-[240px] rounded-xl border border-slate-200 bg-white shadow-xl z-20 overflow-hidden">
                      <p className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-100">
                        Choose order to invoice
                      </p>
                      {truckOrders.map((order) => (
                        <button
                          key={order.id}
                          type="button"
                          onClick={() => openInvoice(order)}
                          className="w-full text-left px-3 py-2.5 text-xs hover:bg-emerald-50 border-b border-slate-50 last:border-b-0"
                        >
                          <span className="font-bold text-gray-900 block truncate">{order.customerName}</span>
                          <span className="text-[10px] text-gray-500 font-mono">Order #{order.orderNumber}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}

            {permissions.canEditTrucks && (
              <button
                onClick={onEditTruck}
                className="inline-flex items-center px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-800 hover:bg-emerald-700 text-white transition-colors border border-emerald-700 shadow-sm"
              >
                <Edit className="h-3.5 w-3.5 mr-1.5" />
                Edit Truck Group
              </button>
            )}
            {permissions.canCheckOffLoading && (
              <>
                <button
                  onClick={handleResetTruck}
                  className="inline-flex items-center px-3.5 py-2 rounded-xl text-xs font-bold bg-white/10 hover:bg-white/20 text-white transition-colors border border-white/25 shadow-sm"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Reset Truck
                </button>
                <button
                  onClick={handleLoadAllTruck}
                  className="inline-flex items-center px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-200 hover:bg-emerald-100 text-emerald-950 transition-colors border border-emerald-100 shadow-sm"
                >
                  <CheckCheck className="h-3.5 w-3.5 mr-1.5" />
                  Load All Truck
                </button>
              </>
            )}
          </div>
        </div>

        {truck.notes && (
          <div className="mt-4 bg-emerald-900/40 border border-emerald-900 rounded-xl p-3 text-xs text-emerald-100 flex items-start space-x-2">
            <Info className="h-4 w-4 text-emerald-300 shrink-0 mt-0.5" />
            <p className="leading-normal"><span className="font-bold font-mono text-emerald-300 uppercase">Load Instructions:</span> {truck.notes}</p>
          </div>
        )}
      </div>

      {/* Stats KPI Ribbon */}
      <div className="grid grid-cols-1 sm:grid-cols-3 border-b border-emerald-500/20 bg-emerald-100/35 shadow-inner">
        <div className="p-4 flex items-center space-x-3 border-r border-b sm:border-b-0 border-emerald-500/20">
          <Weight className="h-5 w-5 text-emerald-800 shrink-0" />
          <div>
            <p className="text-[10px] font-bold text-emerald-900/60 font-mono uppercase leading-tight">Total Truckload Weight</p>
            <p className="text-base font-black text-gray-900 font-mono mt-0.5">
              {totalWeight.toLocaleString()}
              {capacity > 0 ? (
                <span className="text-xs font-normal text-emerald-950 font-sans block sm:inline sm:ml-2">
                  / {capacity.toLocaleString()} lbs ({overallWeightPercentage}% capacity)
                </span>
              ) : (
                <span className="text-xs font-semibold text-emerald-900"> lbs</span>
              )}
            </p>
          </div>
        </div>

        <div className="p-4 flex items-center space-x-3 border-r border-b sm:border-b-0 border-emerald-500/20">
          <Package className="h-5 w-5 text-emerald-800 shrink-0" />
          <div>
            <p className="text-[10px] font-bold text-gray-400 font-mono uppercase leading-tight">Total Plants Count</p>
            <p className="text-base font-black text-gray-900 font-mono mt-0.5">
              {loadedPlants} <span className="text-xs font-semibold text-gray-400">loaded</span> / {totalPlants} pots
            </p>
          </div>
        </div>

        <div className="p-4">
          <div className="flex justify-between text-[10px] mb-1 font-mono leading-tight">
            <span className="font-bold text-gray-400 uppercase">Truck Load Status</span>
            <span className="font-bold text-emerald-800">{overallPercentage}% Complete</span>
          </div>
          <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
            <div
              className="bg-emerald-700 h-full rounded-full transition-all duration-300"
              style={{ width: `${overallPercentage}%` }}
            />
          </div>
        </div>
      </div>

      {/* Active Work Area */}
      <div className="flex-1 overflow-y-auto p-6 max-h-[550px]">
        {truckOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm font-semibold">No orders assigned to this truck.</p>
            <p className="text-xs text-gray-400 mt-1">Please edit the truck load to select customer orders.</p>
          </div>
        ) : (
          /* SEPARATE CUSTOMER CARDS BREAKDOWN */
          <div className="space-y-4">
            {/* Quick Add Standalone Addition Action */}
            {!isCreatingStandalone ? (
              <button
                type="button"
                onClick={() => setIsCreatingStandalone(true)}
                className="w-full py-3 px-4 border border-dashed border-amber-300 hover:border-amber-500 bg-amber-50/20 hover:bg-amber-50/50 text-amber-900 hover:text-amber-950 font-bold text-xs rounded-xl transition-all flex items-center justify-center space-x-2 shadow-sm mb-2"
              >
                <Plus className="h-4 w-4 stroke-[2.5px] text-amber-700 animate-pulse" />
                <span>Create Standalone Load Addition (New Customer/Ticket)</span>
              </button>
            ) : (
              <form
                onSubmit={handleCreateStandaloneAdditionSubmit}
                className="bg-white border-2 border-amber-500 rounded-xl p-4 shadow-sm mb-4 space-y-3 animate-fade-in"
              >
                <div className="flex items-center justify-between border-b border-gray-150 pb-2 flex-wrap gap-2">
                  <h4 className="text-xs font-black text-gray-950 flex items-center">
                    <Plus className="h-4 w-4 mr-1.5 text-amber-700" />
                    Create Standalone Load Addition
                  </h4>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingStandalone(false);
                      setStandaloneError(null);
                    }}
                    className="text-xs text-gray-550 hover:text-gray-750 font-bold"
                  >
                    Cancel
                  </button>
                </div>

                {standaloneError && (
                  <div className="bg-red-50 border border-red-200 text-red-750 text-xs px-3.5 py-2.5 rounded-xl flex items-center space-x-1.5">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{standaloneError}</span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Customer Name / Ticket Label *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Nathan - Yard Addition"
                      value={standaloneCustomerName}
                      onChange={(e) => setStandaloneCustomerName(e.target.value)}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Ticket / Order Number (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. ADD-901 (Auto-generated if blank)"
                      value={standaloneOrderNumber}
                      onChange={(e) => setStandaloneOrderNumber(e.target.value)}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-mono font-bold text-gray-800"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Plant Name / Variety *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Dwarf Burford Holly"
                      value={standalonePlantName}
                      onChange={(e) => setStandalonePlantName(e.target.value)}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Container Size *
                    </label>
                    <select
                      value={standaloneContainerSize}
                      onChange={(e) => setStandaloneContainerSize(e.target.value)}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
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
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Quantity *
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={standaloneQuantity}
                      onChange={(e) => setStandaloneQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-mono font-bold text-gray-800"
                      required
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                      Optional Notes
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Late addition to flatbed"
                      value={standaloneNotes}
                      onChange={(e) => setStandaloneNotes(e.target.value)}
                      className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-amber-500 bg-gray-50 focus:bg-white transition-all font-medium text-gray-800"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-gray-150">
                  <button
                    type="submit"
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-black text-xs rounded-lg shadow-sm hover:shadow transition-all flex items-center space-x-1 cursor-pointer"
                  >
                    <CheckCircle2 className="h-4.5 w-4.5" />
                    <span>Save Standalone Addition to Truck</span>
                  </button>
                </div>
              </form>
            )}

            {truckOrders.map((order) => {
              const isExpanded = expandedOrderId === order.id;
              const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);
              const loadedItems = order.items.reduce((sum, item) => sum + item.loadedQuantity, 0);
              const orderPercentage = totalItems > 0 ? Math.round((loadedItems / totalItems) * 100) : 0;
              const loadIndex = truck.orderIds ? truck.orderIds.indexOf(order.id) : -1;
              const orderTrailerPct = calculateWeightPercentage(order.totalWeightLbs, truck.truckType);

              return (
                <div
                  key={order.id}
                  className={`border-2 rounded-2xl overflow-hidden transition-all ${
                    isExpanded 
                      ? 'border-emerald-600 shadow-md ring-1 ring-emerald-500/25 bg-white' 
                      : 'border-slate-300/80 bg-white hover:border-emerald-500 hover:shadow-md shadow-sm'
                  }`}
                >
                  {/* Card Header toggle */}
                  <div
                    onClick={() => handleToggleOrderExpansion(order.id)}
                    className="p-4 bg-slate-50 hover:bg-slate-100/70 cursor-pointer flex items-center justify-between gap-4 select-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-2 flex-wrap gap-y-1.5">
                        {loadIndex !== -1 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-250/30 font-mono tracking-wide">
                            {loadIndex === 0 ? '1ST TO LOAD' : loadIndex === 1 ? '2ND TO LOAD' : loadIndex === 2 ? '3RD TO LOAD' : `${loadIndex + 1}TH TO LOAD`}
                          </span>
                        )}
                        <h4 className="text-sm font-bold text-gray-900 truncate">
                          {order.customerName}
                        </h4>
                        <span className="text-[10px] font-mono font-bold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                          Order #{order.orderNumber}
                        </span>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-400 font-mono mt-1">
                        <span className="flex items-center shrink-0">
                          <Weight className="h-3 w-3 mr-1 text-gray-300" />
                          {order.totalWeightLbs.toLocaleString()} lbs
                        </span>
                        {orderTrailerPct > 0 && (
                          <span className="shrink-0 bg-amber-50 border border-amber-200 text-amber-900 text-[10px] font-bold font-sans px-1.5 py-0.2 rounded-md">
                            {orderTrailerPct}% of trailer
                          </span>
                        )}
                        <span className="text-gray-300 shrink-0">•</span>
                        <span className="shrink-0">{loadedItems}/{totalItems} items loaded</span>
                        {order.stagedLocation && (
                          <>
                            <span className="text-gray-300 shrink-0">•</span>
                            <span className="shrink-0 inline-flex items-center text-xs font-bold text-slate-700 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded gap-1">
                              <MapPin className="h-3 w-3 text-emerald-700 shrink-0" />
                              <span>Staged: <span className="font-extrabold text-emerald-950">{order.stagedLocation}</span></span>
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0">
                      {permissions.canViewInvoices && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openInvoice(order);
                          }}
                          className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-900 text-white shadow-sm"
                        >
                          <Mail className="h-3.5 w-3.5 mr-1" />
                          Send Invoice
                        </button>
                      )}

                      {/* Inner small progress ring or bar */}
                      <div className="hidden sm:flex items-center space-x-2 text-right">
                        <span className="text-xs font-bold text-emerald-800 font-mono">{orderPercentage}%</span>
                        <div className="w-16 bg-gray-200 h-1.5 rounded-full overflow-hidden">
                          <div className="bg-emerald-700 h-full rounded-full" style={{ width: `${orderPercentage}%` }} />
                        </div>
                      </div>

                      {isExpanded ? (
                        <ChevronUp className="h-5 w-5 text-gray-400" />
                      ) : (
                        <ChevronDown className="h-5 w-5 text-gray-400" />
                      )}
                    </div>
                  </div>

                  {/* Checklist (only if expanded) */}
                  {isExpanded && (
                    <div className="p-4 border-t border-gray-150 bg-white space-y-4">
                      {/* Quick Actions Panel */}
                      <div className="flex flex-wrap gap-2 justify-between items-center border-b border-gray-100 pb-3">
                        <div className="flex items-center space-x-4">
                          <button
                            onClick={() => onSelectOrder(order.id)}
                            className="inline-flex items-center text-xs font-bold text-emerald-800 hover:text-emerald-950 hover:underline"
                          >
                            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                            Open Standalone Workspace
                          </button>
                          {permissions.canViewInvoices && (
                          <button
                            onClick={() => openInvoice(order)}
                            className="inline-flex items-center text-xs font-bold text-slate-700 hover:text-slate-950 hover:underline"
                          >
                            <Mail className="h-3.5 w-3.5 mr-1.5 text-slate-500" />
                            Send Invoice
                          </button>
                          )}
                        </div>
                        
                        <div className="flex space-x-2 items-center">
                          {resettingOrderId === order.id ? (
                            <div className="flex items-center space-x-1 bg-amber-50 border border-amber-200 rounded-lg p-1">
                              <span className="text-[10px] font-bold text-amber-800 px-1">Reset?</span>
                              <button
                                onClick={() => handleResetOrder(order)}
                                className="px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] rounded animate-fade-in"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setResettingOrderId(null)}
                                className="px-2 py-0.5 bg-white border border-gray-200 text-gray-700 font-bold text-[10px] rounded animate-fade-in"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setResettingOrderId(order.id)}
                              disabled={loadedItems === 0}
                              className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                                loadedItems === 0
                                  ? 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed'
                                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-800'
                              }`}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1" />
                              Reset Progress
                            </button>
                          )}
                          <button
                            onClick={() => handleMarkOrderLoaded(order)}
                            disabled={loadedItems >= totalItems}
                            className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                              loadedItems >= totalItems
                                ? 'bg-gray-50 text-gray-300 border border-gray-100 cursor-not-allowed'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-200'
                            }`}
                          >
                            <CheckCheck className="h-3.5 w-3.5 mr-1" />
                            Mark All Loaded
                          </button>
                        </div>
                      </div>

                      {/* Quick Add Plant Action */}
                      {addingPlantToOrderId !== order.id ? (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingPlantToOrderId(order.id);
                            setNewPlantName('');
                            setNewContainerSize('');
                            setNewQuantity(1);
                            setNewIsAddition(true);
                            setNewNotes('');
                            setAddError(null);
                          }}
                          className="w-full py-2.5 px-3 border border-dashed border-emerald-300 hover:border-emerald-500 bg-emerald-50/20 hover:bg-emerald-50/50 text-emerald-850 hover:text-emerald-950 font-bold text-xs rounded-xl transition-all flex items-center justify-center space-x-1.5 shadow-sm"
                        >
                          <Plus className="h-3.5 w-3.5 stroke-[2.5px] text-emerald-700" />
                          <span>Add Plant Addition / Add-on to this Order</span>
                        </button>
                      ) : (
                        <form
                          onSubmit={(e) => handleAddPlantToOrderSubmit(e, order)}
                          className="bg-slate-50 border-2 border-emerald-500 rounded-xl p-4 shadow-sm space-y-3 animate-fade-in"
                        >
                          <div className="flex items-center justify-between border-b border-gray-250 pb-2">
                            <h4 className="text-xs font-black text-gray-900 flex items-center">
                              <Plus className="h-3.5 w-3.5 mr-1 text-emerald-700" />
                              Add Plant Addition to {order.customerName}
                            </h4>
                            <button
                              type="button"
                              onClick={() => {
                                setAddingPlantToOrderId(null);
                                setAddError(null);
                              }}
                              className="text-[11px] text-gray-500 hover:text-gray-700 font-bold"
                            >
                              Cancel
                            </button>
                          </div>

                          {addError && (
                            <div className="bg-red-50 border border-red-200 text-red-750 text-[11px] px-3 py-2 rounded-lg flex items-center space-x-1.5">
                              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                              <span>{addError}</span>
                            </div>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="col-span-1 sm:col-span-2">
                              <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                                Plant Name / Variety *
                              </label>
                              <input
                                type="text"
                                placeholder="e.g. Dwarf Burford Holly"
                                value={newPlantName}
                                onChange={(e) => setNewPlantName(e.target.value)}
                                className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white transition-all font-medium text-gray-800"
                                required
                              />
                            </div>
                            <div>
                              <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                                Container Size *
                              </label>
                              <select
                                value={newContainerSize}
                                onChange={(e) => setNewContainerSize(e.target.value)}
                                className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white transition-all font-medium text-gray-800"
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
                              <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                                Quantity *
                              </label>
                              <input
                                type="number"
                                min="1"
                                value={newQuantity}
                                onChange={(e) => setNewQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                                className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white transition-all font-mono font-bold text-gray-800"
                                required
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-[9px] font-bold text-gray-400 uppercase font-mono mb-1">
                                Optional Notes
                              </label>
                              <input
                                type="text"
                                placeholder="e.g. Tag-along / Late add"
                                value={newNotes}
                                onChange={(e) => setNewNotes(e.target.value)}
                                className="block w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:border-emerald-500 bg-white transition-all font-medium text-gray-800"
                              />
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-1 border-t border-gray-200">
                            <label className="flex items-center space-x-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={newIsAddition}
                                onChange={(e) => setNewIsAddition(e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-700 focus:ring-emerald-500 cursor-pointer"
                              />
                              <span className="text-[10px] font-bold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                                Mark as Addition
                              </span>
                            </label>

                            <button
                              type="submit"
                              className="px-3.5 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs rounded-lg shadow-sm transition-all flex items-center space-x-1"
                            >
                              <CheckCheck className="h-3 w-3" />
                              <span>Save Addition</span>
                            </button>
                          </div>
                        </form>
                      )}

                      {/* Items checklist */}
                      <div className="divide-y divide-gray-100">
                        {order.items.map((item) => {
                          const isUpdating = updatingItemId === `${order.id}-${item.id}`;
                          const isUpdatingPulled = updatingItemId === `${order.id}-${item.id}-pulled`;
                          const isFullyLoaded = item.loadedQuantity >= item.quantity;
                          const isFullyPulled = (item.pulledQuantity ?? 0) >= item.quantity;
                          const isEditing = editingItemId === `${order.id}-${item.id}`;

                          return (
                            <div key={item.id} className="py-3">
                              {isEditing ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    handleSaveEditedItem(order, item.id);
                                  }}
                                  className="space-y-3 bg-slate-50 border border-slate-200 rounded-lg p-3 w-full"
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
                                        className="block w-full px-2 py-1 border border-gray-250 rounded-md text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
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
                                        className="block w-full px-2 py-1 border border-gray-250 rounded-md text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
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
                                        className="block w-full px-2 py-1 border border-gray-250 rounded-md text-xs focus:outline-none focus:border-emerald-500 bg-white font-mono font-bold text-gray-800"
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
                                        className="block w-full px-2 py-1 border border-gray-250 rounded-md text-xs focus:outline-none focus:border-emerald-500 bg-white font-medium text-gray-800"
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
                                        className="px-2 py-1 border border-gray-250 text-gray-600 rounded-md text-[10px] font-bold bg-white hover:bg-gray-50"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="submit"
                                        className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded-md text-[10px] font-bold shadow-sm"
                                      >
                                        Save
                                      </button>
                                    </div>
                                  </div>
                                </form>
                              ) : (
                                <div className="flex flex-col gap-3 w-full">
                                  <div className="min-w-0">
                                    <div className="text-xs font-bold text-gray-900 flex items-center flex-wrap gap-1.5">
                                      <span>{item.plantName}</span>
                                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-800 font-mono border border-slate-150">
                                        {item.containerSize}
                                      </span>
                                      {item.isAddition && (
                                        <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-amber-500 text-amber-950 border border-amber-400">
                                          ADDITION
                                        </span>
                                      )}
                                      
                                      {/* Quick edit/delete triggers */}
                                      <span className="inline-flex items-center space-x-1 shrink-0 ml-1">
                                        <button
                                          onClick={() => {
                                            setEditingItemId(`${order.id}-${item.id}`);
                                            setEditPlantName(item.plantName);
                                            setEditContainerSize(item.containerSize);
                                            setEditQuantity(item.quantity);
                                            setEditNotes(item.notes || '');
                                            setEditIsAddition(!!item.isAddition);
                                          }}
                                          className="p-0.5 text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 rounded"
                                          title="Edit item details"
                                        >
                                          <Edit className="h-3 w-3 text-gray-400 hover:text-emerald-600" />
                                        </button>
                                        <button
                                          onClick={() => handleDeleteItem(order, item.id)}
                                          className="p-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                                          title="Delete item"
                                        >
                                          <Trash2 className="h-3 w-3 text-gray-400 hover:text-red-600" />
                                        </button>
                                      </span>
                                    </div>
                                    {item.notes && (
                                      <p className="text-[10px] text-amber-700 font-medium italic mt-0.5">
                                        Note: {item.notes}
                                      </p>
                                    )}
                                  </div>

                                  {/* Pulled + Loaded — stacked on mobile so controls aren't clipped */}
                                  <div className="grid grid-cols-2 gap-3 w-full border-t border-gray-100 pt-3 sm:flex sm:items-start sm:justify-end sm:gap-4 sm:border-0 sm:pt-0 sm:w-auto sm:ml-auto">
                                    <div className="flex flex-col items-center gap-1.5 bg-teal-50/40 border border-teal-200/60 rounded-xl p-2.5">
                                      <label className="text-[10px] font-bold text-teal-700 uppercase tracking-wide cursor-pointer select-none">
                                        Pulled
                                      </label>
                                      <input
                                        type="checkbox"
                                        checked={isFullyPulled}
                                        onChange={() => handleMarkItemFullyPulled(order.id, order, item.id)}
                                        disabled={!permissions.canCheckOffLoading}
                                        className="h-8 w-8 sm:h-7 sm:w-7 rounded-md border-2 border-teal-300 text-teal-600 focus:ring-teal-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                                        title={isFullyPulled ? 'Undo pulled' : 'Mark all pulled'}
                                        aria-label={isFullyPulled ? 'Undo pulled' : 'Mark all pulled'}
                                      />
                                      <div className="flex items-center space-x-1.5">
                                        <button
                                          onClick={() => handlePulledAdjust(order.id, order, item.id, (item.pulledQuantity ?? 0) - 1)}
                                          disabled={(item.pulledQuantity ?? 0) <= 0 || isUpdatingPulled || !permissions.canCheckOffLoading}
                                          className="w-8 h-8 sm:w-7 sm:h-7 rounded-lg border border-gray-200 hover:border-teal-300 hover:bg-teal-50 text-gray-500 font-extrabold flex items-center justify-center transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                          -
                                        </button>
                                        <span className={`text-xs font-black font-mono w-12 text-center py-1 border border-gray-100 bg-white rounded-md ${isFullyPulled ? 'text-teal-800' : 'text-gray-800'}`}>
                                          {item.pulledQuantity ?? 0} <span className="text-[10px] font-normal text-gray-400">/</span> {item.quantity}
                                        </span>
                                        <button
                                          onClick={() => handlePulledAdjust(order.id, order, item.id, (item.pulledQuantity ?? 0) + 1)}
                                          disabled={isFullyPulled || isUpdatingPulled || !permissions.canCheckOffLoading}
                                          className="w-8 h-8 sm:w-7 sm:h-7 rounded-lg border border-gray-200 hover:border-teal-300 hover:bg-teal-50 text-gray-500 font-extrabold flex items-center justify-center transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                          +
                                        </button>
                                      </div>
                                    </div>
                                    <div className="flex flex-col items-center gap-1.5 bg-emerald-50/40 border border-emerald-200/60 rounded-xl p-2.5">
                                      <label className="text-[10px] font-bold text-emerald-700 uppercase tracking-wide cursor-pointer select-none">
                                        Loaded
                                      </label>
                                      <input
                                        type="checkbox"
                                        checked={isFullyLoaded}
                                        onChange={() => handleMarkItemFullyLoaded(order.id, order, item.id)}
                                        disabled={!permissions.canCheckOffLoading}
                                        className="h-8 w-8 sm:h-7 sm:w-7 rounded-md border-2 border-emerald-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                                        title={isFullyLoaded ? 'Undo loaded' : 'Mark all loaded'}
                                        aria-label={isFullyLoaded ? 'Undo loaded' : 'Mark all loaded'}
                                      />
                                      <div className="flex items-center space-x-1.5">
                                        <button
                                          onClick={() => handleQuantityAdjust(order.id, order, item.id, item.loadedQuantity - 1)}
                                          disabled={item.loadedQuantity <= 0 || isUpdating || !permissions.canCheckOffLoading}
                                          className="w-8 h-8 sm:w-7 sm:h-7 rounded-lg border border-gray-200 hover:border-emerald-300 hover:bg-emerald-50 text-gray-500 font-extrabold flex items-center justify-center transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                          -
                                        </button>
                                        <span className={`text-xs font-black font-mono w-12 text-center py-1 border border-gray-100 bg-white rounded-md ${isFullyLoaded ? 'text-emerald-800 font-black' : 'text-gray-800'}`}>
                                          {item.loadedQuantity} <span className="text-[10px] font-normal text-gray-400">/</span> {item.quantity}
                                        </span>
                                        <button
                                          onClick={() => handleQuantityAdjust(order.id, order, item.id, item.loadedQuantity + 1)}
                                          disabled={isFullyLoaded || isUpdating || !permissions.canCheckOffLoading}
                                          className="w-8 h-8 sm:w-7 sm:h-7 rounded-lg border border-gray-200 hover:border-emerald-300 hover:bg-emerald-50 text-gray-500 font-extrabold flex items-center justify-center transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                          +
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {permissions.canViewBOL && (
      <BillOfLadingModal
        isOpen={isBOLOpen}
        onClose={() => setIsBOLOpen(false)}
        truck={truck}
        orders={orders}
        containerWeights={containerWeights}
      />
      )}

      {permissions.canViewInvoices && invoiceOrder && (
        <InvoiceModal
          isOpen={invoiceOrder !== null}
          onClose={() => setInvoiceOrder(null)}
          order={invoiceOrder}
          customer={
            customers.find((c) => c.id === invoiceOrder.customerId) ||
            customers.find(
              (c) =>
                c.name.trim().toLowerCase() === invoiceOrder.customerName.trim().toLowerCase()
            ) ||
            null
          }
          nurseryName={nurseryName}
        />
      )}
    </div>
  );
};
