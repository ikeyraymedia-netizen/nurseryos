import React, { useState, useEffect } from 'react';
import { Truck, CustomerOrder } from '../types';
import { addTruck, updateTruck } from '../lib/db';
import { X, Check, Save, Truck as TruckIcon, HelpCircle, ChevronUp, ChevronDown } from 'lucide-react';
import { getTruckWeightCapacity, calculateWeightPercentage } from '../lib/capacity';
import { toDateKey } from '../lib/dates';
import { useSalesRepOptions } from '../lib/salesReps';

interface TruckBuilderProps {
  truckToEdit?: Truck | null;
  orders: CustomerOrder[];
  tenantId?: string;
  onCancel: () => void;
  onSuccess: (truckId: string) => void;
}

export const TruckBuilder: React.FC<TruckBuilderProps> = ({
  truckToEdit,
  orders,
  tenantId,
  onCancel,
  onSuccess
}) => {
  const ownerOptions = useSalesRepOptions(tenantId);
  const [name, setName] = useState('');
  const [carrier, setCarrier] = useState('');
  const [truckType, setTruckType] = useState('');
  const [notes, setNotes] = useState('');
  const [loadingDate, setLoadingDate] = useState(() => toDateKey(new Date()));
  const [owner, setOwner] = useState('');
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load editing state
  useEffect(() => {
    if (truckToEdit) {
      setName(truckToEdit.name);
      setCarrier(truckToEdit.carrier || '');
      setTruckType(truckToEdit.truckType || '');
      setNotes(truckToEdit.notes || '');
      setLoadingDate(truckToEdit.loadingDate || toDateKey(new Date()));
      setOwner(truckToEdit.owner || '');
      setSelectedOrderIds(truckToEdit.orderIds || []);
    } else {
      setName('');
      setCarrier('');
      setTruckType('');
      setNotes('');
      setLoadingDate(toDateKey(new Date()));
      setOwner('');
      setSelectedOrderIds([]);
    }
    setError(null);
  }, [truckToEdit]);

  // Orders available for selection:
  // Show unassigned orders OR orders assigned to this active truck
  const selectableOrders = orders.filter((order) => {
    if (!order.truckId) return true;
    if (truckToEdit && order.truckId === truckToEdit.id) return true;
    return false;
  });

  const handleToggleOrder = (orderId: string) => {
    setSelectedOrderIds((prev) => {
      if (prev.includes(orderId)) {
        return prev.filter((id) => id !== orderId);
      } else {
        return [...prev, orderId];
      }
    });
  };

  const handleMoveOrder = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === selectedOrderIds.length - 1) return;

    const newOrderIds = [...selectedOrderIds];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    const temp = newOrderIds[index];
    newOrderIds[index] = newOrderIds[targetIndex];
    newOrderIds[targetIndex] = temp;

    setSelectedOrderIds(newOrderIds);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide a name or label for this truck.');
      return;
    }
    if (!truckType) {
      setError('Please select a truck type.');
      return;
    }
    if (selectedOrderIds.length === 0) {
      setError('Please select at least one customer order to load on this truck.');
      return;
    }
    if (!loadingDate) {
      setError('Please set a loading date so this truck appears on the Trucks week board.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (truckToEdit) {
        const updatedTruck: Truck = {
          ...truckToEdit,
          name: name.trim(),
          carrier: carrier.trim(),
          truckType: truckType,
          notes: notes.trim(),
          loadingDate: loadingDate,
          owner: owner,
          orderIds: selectedOrderIds
        };
        await updateTruck(updatedTruck);
        onSuccess(truckToEdit.id);
      } else {
        const newTruckId = await addTruck({
          name: name.trim(),
          carrier: carrier.trim(),
          truckType: truckType,
          notes: notes.trim(),
          loadingDate: loadingDate,
          owner: owner,
          orderIds: selectedOrderIds
        });
        onSuccess(newTruckId);
      }
    } catch (err: any) {
      console.error('Failed to save truck:', err);
      setError(err.message || 'An error occurred while saving the truck load.');
    } finally {
      setSaving(false);
    }
  };

  // Compute live calculations
  const totalWeightSelected = orders
    .filter((o) => selectedOrderIds.includes(o.id))
    .reduce((sum, o) => sum + o.totalWeightLbs, 0);

  const totalPotsSelected = orders
    .filter((o) => selectedOrderIds.includes(o.id))
    .reduce((sum, o) => sum + o.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);

  const capacityLimitLbs = getTruckWeightCapacity(truckType);
  const limitPercentage =
    capacityLimitLbs > 0
      ? Math.min(Math.round((totalWeightSelected / capacityLimitLbs) * 100), 100)
      : 0;

  return (
    <div className="bg-emerald-50/50 rounded-2xl border-2 border-emerald-600/30 shadow-md overflow-hidden flex flex-col min-h-[min(720px,calc(100dvh-11rem))]">
      {/* Form Header */}
      <div className="bg-emerald-950 text-white px-6 py-4 flex items-center justify-between border-b border-emerald-900 shrink-0">
        <div className="flex items-center space-x-2">
          <TruckIcon className="h-5 w-5 text-emerald-300" />
          <h3 className="text-base font-bold font-sans">
            {truckToEdit ? `Edit Truck Load: ${truckToEdit.name}` : 'Build a Custom Truck Load'}
          </h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-emerald-200 hover:text-white p-1 rounded-lg hover:bg-emerald-900 transition-colors"
          title="Cancel"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-6 min-h-0">
          {error && (
            <div className="bg-red-50 text-red-800 text-xs font-bold p-3.5 rounded-xl border border-red-200 flex items-center space-x-2">
              <span className="shrink-0 font-mono">⚠️ Error:</span>
              <span>{error}</span>
            </div>
          )}

          {/* Logistics Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                Sales Rep *
              </label>
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
                required
              >
                <option value="">Select sales rep...</option>
                {ownerOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {owner && !ownerOptions.includes(owner) && (
                  <option value={owner}>{owner}</option>
                )}
              </select>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Team members with Owner, Admin, or Sales roles.
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                Truck Label / Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Lafayette - Flatbed #1"
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                Loading Date *
              </label>
              <input
                type="date"
                value={loadingDate}
                onChange={(e) => setLoadingDate(e.target.value)}
                required
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
              />
              <p className="text-[10px] text-gray-500 mt-1 leading-snug">
                Places this truck on that day in the Trucks week board (Sun–Sat).
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                Logistics Carrier / Driver
              </label>
              <input
                type="text"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="e.g. Cajun Freight / driver Bobby"
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                Truck Type *
              </label>
              <select
                value={truckType}
                onChange={(e) => setTruckType(e.target.value)}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
                required
              >
                <option value="">Select Type...</option>
                <option value="28' Gooseneck">28' Gooseneck</option>
                <option value="30' Gooseneck">30' Gooseneck</option>
                <option value="32' Gooseneck">32' Gooseneck</option>
                <option value="36' Gooseneck">36' Gooseneck</option>
                <option value="24' Bumper Pull">24' Bumper Pull</option>
                <option value="Hotshot">Hotshot</option>
                <option value="26' Box">26' Box</option>
                <option value="26' Refer">26' Refer</option>
                <option value="53' Semi">53' Semi</option>
                <option value="53' Refer">53' Refer</option>
                <option value="Flatbed Gooseneck">Flatbed Gooseneck</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
              Loading Instructions / Driver Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Load heavy #45 first, tie down canvas securely, separate Lafayette orders near cab..."
              rows={2}
              className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500 bg-gray-50 focus:bg-white transition-all font-sans"
            />
          </div>

          {/* Orders Picker Checklist */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-gray-700 font-mono uppercase">
                Select Orders to Load *
              </label>
              <span className="text-[11px] font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-md">
                {selectableOrders.length} Available
              </span>
            </div>

            {selectableOrders.length === 0 ? (
              <div className="text-center py-8 bg-slate-50 border border-dashed border-slate-200 rounded-xl text-gray-500">
                <p className="text-xs font-bold">No available orders found</p>
                <p className="text-[10px] text-gray-400 mt-1 max-w-[240px] mx-auto leading-normal">
                  All active plant orders are already assigned to trucks. Upload new customer papers or delete a truck load to release its orders.
                </p>
              </div>
            ) : (
              <div className="border border-gray-150 rounded-xl max-h-[220px] overflow-y-auto bg-gray-50 p-2 space-y-1.5">
                {selectableOrders.map((order) => {
                  const isChecked = selectedOrderIds.includes(order.id);
                  const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);

                  return (
                    <div
                      key={order.id}
                      onClick={() => handleToggleOrder(order.id)}
                      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer select-none transition-all ${
                        isChecked
                          ? 'border-emerald-500 bg-emerald-50/50 shadow-sm'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${
                          isChecked ? 'bg-emerald-700 border-emerald-700 text-white' : 'border-gray-300 bg-white'
                        }`}>
                          {isChecked && <Check className="h-3.5 w-3.5" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-gray-900 truncate">
                            {order.customerName}
                          </p>
                          <p className="text-[10px] text-gray-400 font-mono">
                            Order #: {order.orderNumber} • {totalItems} plants
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-bold text-gray-800 font-mono">
                          {order.totalWeightLbs.toLocaleString()} lbs
                        </p>
                        <p className="text-[9px] text-gray-400 font-mono capitalize">
                          Status: {order.status === 'completed' ? 'loaded' : order.status}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Determine Loading Sequence */}
          {selectedOrderIds.length > 0 && (
            <div className="bg-slate-50 border border-gray-150 p-4 rounded-2xl space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-xs font-bold text-gray-800 font-mono uppercase">
                    Determine Loading Sequence *
                  </label>
                  <p className="text-[10px] text-gray-500 font-sans mt-0.5 leading-normal">
                    Specify the sequence in which these customer shipments will be physically loaded onto the truck (e.g. 1st, 2nd, 3rd). Use the arrows to reorder.
                  </p>
                </div>
                <span className="text-[10px] font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-md shrink-0">
                  {selectedOrderIds.length} Assigned
                </span>
              </div>

              <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                {selectedOrderIds.map((id, index) => {
                  const order = orders.find((o) => o.id === id);
                  if (!order) return null;

                  const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);
                  const isFirst = index === 0;
                  const isLast = index === selectedOrderIds.length - 1;

                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between p-3 bg-white rounded-xl border border-gray-150 shadow-sm gap-3 hover:border-gray-300 transition-all"
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        {/* Position Badge */}
                        <div className="w-14 shrink-0 flex flex-col items-center justify-center bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-lg py-1.5 font-mono">
                          <span className="text-[9px] font-black leading-none uppercase tracking-wide opacity-80">LOAD</span>
                          <span className="text-xs font-black mt-1 leading-none text-emerald-950">
                            {index === 0 ? '1st' : index === 1 ? '2nd' : index === 2 ? '3rd' : `${index + 1}th`}
                          </span>
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs font-black text-gray-900 truncate">
                            {order.customerName}
                          </p>
                          <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                            Order #{order.orderNumber} • {totalItems} plants • {order.totalWeightLbs.toLocaleString()} lbs
                          </p>
                        </div>
                      </div>

                      {/* Move Up/Down Controls */}
                      <div className="flex items-center space-x-1 shrink-0">
                        <button
                          type="button"
                          disabled={isFirst}
                          onClick={() => handleMoveOrder(index, 'up')}
                          className="w-8 h-8 rounded-lg border border-gray-200 hover:border-emerald-500 hover:bg-emerald-50 text-gray-500 hover:text-emerald-800 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-gray-200 disabled:hover:text-gray-500 flex items-center justify-center transition-all"
                          title="Move Up (Load Earlier)"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={isLast}
                          onClick={() => handleMoveOrder(index, 'down')}
                          className="w-8 h-8 rounded-lg border border-gray-200 hover:border-emerald-500 hover:bg-emerald-50 text-gray-500 hover:text-emerald-800 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-gray-200 disabled:hover:text-gray-500 flex items-center justify-center transition-all"
                          title="Move Down (Load Later)"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Live Weight Tracker & Actions Panel — always visible at bottom */}
        <div className="shrink-0 border-t border-gray-200 bg-slate-50 p-4 sm:p-6 space-y-4 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
          {/* Live Stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white p-3 rounded-xl border border-gray-150 shadow-inner">
              <p className="text-[9px] font-bold text-gray-400 font-mono uppercase">Orders Selected</p>
              <p className="text-lg font-black text-emerald-950 font-mono mt-0.5">
                {selectedOrderIds.length} <span className="text-xs font-normal text-gray-500">loads</span>
              </p>
            </div>
            <div className="bg-white p-3 rounded-xl border border-gray-150 shadow-inner">
              <p className="text-[9px] font-bold text-gray-400 font-mono uppercase">Cumulative Weight</p>
              <p className="text-lg font-black text-emerald-950 font-mono mt-0.5">
                {totalWeightSelected.toLocaleString()} <span className="text-xs font-normal text-gray-500">lbs</span>
              </p>
            </div>
          </div>

          {/* DOT Weight Limit Tracker */}
          <div className="bg-white p-3.5 rounded-xl border border-gray-150">
            <div className="flex justify-between text-[10px] mb-1 font-mono">
              <span className="font-bold text-gray-500 uppercase flex items-center">
                {truckType ? `${truckType} Payload Gauge` : "Trailer Payload Gauge"}
              </span>
              <span className={`font-black ${capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs ? 'text-red-600 animate-pulse' : 'text-emerald-800'}`}>
                {capacityLimitLbs > 0
                  ? `${totalWeightSelected.toLocaleString()} / ${capacityLimitLbs.toLocaleString()} lbs (${limitPercentage}%)`
                  : `${totalWeightSelected.toLocaleString()} lbs — select truck type for capacity`}
              </span>
            </div>
            <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs
                    ? 'bg-red-600'
                    : limitPercentage > 85
                    ? 'bg-amber-500'
                    : 'bg-emerald-700'
                }`}
                style={{ width: capacityLimitLbs > 0 ? `${limitPercentage}%` : '0%' }}
              />
            </div>
            {capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs && (
              <p className="text-[9px] text-red-600 font-bold mt-1.5 font-mono">
                ⚠️ OVERWEIGHT WARNING: Exceeds {truckType || 'selected trailer'} capacity limit of {capacityLimitLbs.toLocaleString()} lbs. Consider splitting.
              </p>
            )}
          </div>

          {/* Save/Cancel Actions */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2.5 text-xs font-bold text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || selectedOrderIds.length === 0}
              className={`px-5 py-2.5 text-xs font-bold rounded-xl shadow-md transition-all flex items-center space-x-1.5 ${
                selectedOrderIds.length === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed shadow-none'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white'
              }`}
            >
              {saving ? (
                <span>Saving Truck...</span>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>{truckToEdit ? 'Update Truck' : 'Save Truck'}</span>
                </>
              )}
            </button>
          </div>
          {selectedOrderIds.length === 0 && (
            <p className="text-[10px] text-gray-500 text-right font-mono">
              Select at least one order above, then tap Save Truck.
            </p>
          )}
        </div>
      </form>
    </div>
  );
};
