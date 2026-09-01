import React, { useState, useEffect } from 'react';
import { Truck, CustomerOrder } from '../types';
import { addTruck, updateTruck } from '../lib/db';
import { notifyPushEvent } from '../lib/pushNotifications';
import { X, Check, Save, Truck as TruckIcon, HelpCircle, ChevronUp, ChevronDown } from 'lucide-react';
import { getTruckWeightCapacity, calculateWeightPercentage } from '../lib/capacity';
import { toDateKey } from '../lib/dates';
import { dropNumber, loadNumber } from '../lib/loadSequence';
import { useSalesRepOptions } from '../lib/salesReps';
import { useT } from '../lib/i18n';
import { orderRefLabel } from '../lib/orderLabels';

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
  const t = useT();
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
      setError(t('truckBuilder.nameRequired'));
      return;
    }
    if (!truckType) {
      setError(t('truckBuilder.typeRequired'));
      return;
    }
    if (selectedOrderIds.length === 0) {
      setError(t('truckBuilder.ordersRequired'));
      return;
    }
    if (!loadingDate) {
      setError(t('truckBuilder.dateRequired'));
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
        if (tenantId) {
          void notifyPushEvent({
            tenantId,
            type: 'truck_built',
            title: `New truck · ${name.trim()}`,
            body: `${selectedOrderIds.length} order${selectedOrderIds.length === 1 ? '' : 's'}`,
            url: `/?tab=trucks&truck=${newTruckId}`
          });
        }
        onSuccess(newTruckId);
      }
    } catch (err: any) {
      console.error('Failed to save truck:', err);
      setError(err.message || t('truckBuilder.saveFailed'));
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
    <div className="bg-ink-50/50 rounded-2xl border-2 border-ink-600/30 shadow-md overflow-hidden flex flex-col min-h-[min(720px,calc(100dvh-11rem))]">
      {/* Form Header */}
      <div className="bg-ink-950 text-white px-6 py-4 flex items-center justify-between border-b border-white/10 shrink-0">
        <div className="flex items-center space-x-2">
          <TruckIcon className="h-5 w-5 text-white/70" />
          <h3 className="text-base font-bold font-sans">
            {truckToEdit
              ? t('trucks.editTruckLoad', { name: truckToEdit.name })
              : t('trucks.buildCustomTruck')}
          </h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-white/80 hover:text-white p-1 rounded-lg border border-transparent hover:border-white/30 hover:bg-white/10 transition-colors"
          title={t('common.cancel')}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-6 min-h-0">
          {error && (
            <div className="bg-red-50 text-red-800 text-xs font-bold p-3.5 rounded-xl border border-red-200 flex items-center space-x-2">
              <span className="shrink-0 font-mono">{t('truckBuilder.errorPrefix')}</span>
              <span>{error}</span>
            </div>
          )}

          {/* Logistics Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                {t('truckBuilder.salesRep')}
              </label>
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
                required
              >
                <option value="">{t('loader.selectSalesRep')}</option>
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
                {t('truckBuilder.salesRepHint')}
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                {t('truckBuilder.truckLabel')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('truckBuilder.truckLabelPlaceholder')}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                {t('trucks.loadingDateLabel')}
              </label>
              <input
                type="date"
                value={loadingDate}
                onChange={(e) => setLoadingDate(e.target.value)}
                required
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
              />
              <p className="text-[10px] text-gray-500 mt-1 leading-snug">
                {t('truckBuilder.dateHint')}
              </p>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                {t('truckBuilder.carrier')}
              </label>
              <input
                type="text"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder={t('truckBuilder.carrierPlaceholder')}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
                {t('truckBuilder.truckType')}
              </label>
              <select
                value={truckType}
                onChange={(e) => setTruckType(e.target.value)}
                className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans font-medium text-gray-800"
                required
              >
                <option value="">{t('truckBuilder.selectType')}</option>
                <option value="28' Gooseneck">28' Gooseneck</option>
                <option value="30' Gooseneck">30' Gooseneck</option>
                <option value="32' Gooseneck">32' Gooseneck</option>
                <option value="36' Gooseneck">36' Gooseneck</option>
                <option value="40' Gooseneck">40' Gooseneck</option>
                <option value="24' Bumper Pull">24' Bumper Pull</option>
                <option value="Hotshot">Hotshot</option>
                <option value="26' Box">26' Box</option>
                <option value="26' Refer">26' Refer</option>
                <option value="53' Semi">53' Semi</option>
                <option value="53' Refer">53' Refer</option>
                <option value="Semi Flatbed">Semi Flatbed</option>
                <option value="Flatbed Gooseneck">Flatbed Gooseneck</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 font-mono mb-1.5 uppercase">
              {t('trucks.driverNotes')}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('truckBuilder.driverNotesPlaceholder')}
              rows={2}
              className="block w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-ink-500 bg-gray-50 focus:bg-white transition-all font-sans"
            />
          </div>

          {/* Orders Picker Checklist */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-gray-700 font-mono uppercase">
                {t('trucks.selectOrders')}
              </label>
              <span className="text-[11px] font-mono font-bold text-ink-800 bg-ink-50 border border-ink-100 px-2 py-0.5 rounded-md">
                {t('truckBuilder.ordersAvailable', { n: selectableOrders.length })}
              </span>
            </div>

            {selectableOrders.length === 0 ? (
              <div className="text-center py-8 bg-slate-50 border border-dashed border-slate-200 rounded-xl text-gray-500">
                <p className="text-xs font-bold">{t('truckBuilder.noOrders')}</p>
                <p className="text-[10px] text-gray-400 mt-1 max-w-[240px] mx-auto leading-normal">
                  {t('truckBuilder.noOrdersHintActive')}
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
                          ? 'border-ink-500 bg-ink-50/50 shadow-sm'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all ${
                          isChecked ? 'bg-ink-700 border-ink-700 text-white' : 'border-gray-300 bg-white'
                        }`}>
                          {isChecked && <Check className="h-3.5 w-3.5" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-gray-900 truncate">
                            {order.customerName}
                          </p>
                          <p className="text-[10px] text-gray-400 font-mono">
                            {orderRefLabel(order)
                              ? `${orderRefLabel(order)} • ${totalItems} plants`
                              : `${totalItems} plants`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-bold text-gray-800 font-mono">
                          {order.totalWeightLbs.toLocaleString()} lbs
                        </p>
                        <p className="text-[9px] text-gray-400 font-mono capitalize">
                          {order.status === 'completed'
                            ? t('truckBuilder.statusLoaded')
                            : t('truckBuilder.status', { status: order.status })}
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
                    {t('trucks.loadingSequence')}
                  </label>
                  <p className="text-[10px] text-gray-500 font-sans mt-0.5 leading-normal">
                    {t('truckBuilder.sequenceDetail')}
                  </p>
                </div>
                <span className="text-[10px] font-mono font-bold text-ink-800 bg-ink-50 border border-ink-100 px-2 py-0.5 rounded-md shrink-0">
                  {t('truckBuilder.ordersAssigned', { n: selectedOrderIds.length })}
                </span>
              </div>

              <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
                {selectedOrderIds.map((id, index) => {
                  const order = orders.find((o) => o.id === id);
                  if (!order) return null;

                  const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);
                  const isFirst = index === 0;
                  const isLast = index === selectedOrderIds.length - 1;

                  const loadN = loadNumber(selectedOrderIds, id);
                  const dropN = dropNumber(selectedOrderIds, id);
                  const ordinal = (n: number) =>
                    n === 1
                      ? t('truckBuilder.first')
                      : n === 2
                        ? t('truckBuilder.second')
                        : n === 3
                          ? t('truckBuilder.third')
                          : t('truckBuilder.nth', { n });

                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between p-3 bg-white rounded-xl border border-gray-150 shadow-sm gap-3 hover:border-gray-300 transition-all"
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-[4.25rem] shrink-0 flex flex-col items-center justify-center bg-ink-50 text-ink-800 border border-ink-100 rounded-lg py-1.5 font-mono gap-1">
                          <span className="text-[8px] font-black leading-none uppercase tracking-wide opacity-80">
                            {t('truckBuilder.loadOrdinal')} {ordinal(loadN)}
                          </span>
                          <span className="text-[8px] font-black leading-none uppercase tracking-wide text-ink-950">
                            {t('truckBuilder.dropOrdinal')} {ordinal(dropN)}
                          </span>
                        </div>

                        <div className="min-w-0">
                          <p className="text-xs font-black text-gray-900 truncate">
                            {order.customerName}
                          </p>
                          <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                            {orderRefLabel(order)
                              ? `${orderRefLabel(order)} • ${totalItems} plants • ${order.totalWeightLbs.toLocaleString()} lbs`
                              : `${totalItems} plants • ${order.totalWeightLbs.toLocaleString()} lbs`}
                          </p>
                        </div>
                      </div>

                      {/* Move Up/Down Controls */}
                      <div className="flex items-center space-x-1 shrink-0">
                        <button
                          type="button"
                          disabled={isFirst}
                          onClick={() => handleMoveOrder(index, 'up')}
                          className="w-8 h-8 rounded-lg border border-gray-200 hover:border-ink-500 hover:bg-ink-50 text-gray-500 hover:text-ink-800 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-gray-200 disabled:hover:text-gray-500 flex items-center justify-center transition-all"
                          title={t('trucks.moveUp')}
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={isLast}
                          onClick={() => handleMoveOrder(index, 'down')}
                          className="w-8 h-8 rounded-lg border border-gray-200 hover:border-ink-500 hover:bg-ink-50 text-gray-500 hover:text-ink-800 disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-gray-200 disabled:hover:text-gray-500 flex items-center justify-center transition-all"
                          title={t('trucks.moveDown')}
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
              <p className="text-[9px] font-bold text-gray-400 font-mono uppercase">
                {t('truckBuilder.ordersSelected')}
              </p>
              <p className="text-lg font-black text-ink-950 font-mono mt-0.5">
                {selectedOrderIds.length}{' '}
                <span className="text-xs font-normal text-gray-500">{t('truckBuilder.loads')}</span>
              </p>
            </div>
            <div className="bg-white p-3 rounded-xl border border-gray-150 shadow-inner">
              <p className="text-[9px] font-bold text-gray-400 font-mono uppercase">
                {t('truckBuilder.cumulativeWeight')}
              </p>
              <p className="text-lg font-black text-ink-950 font-mono mt-0.5">
                {totalWeightSelected.toLocaleString()}{' '}
                <span className="text-xs font-normal text-gray-500">{t('common.lbs')}</span>
              </p>
            </div>
          </div>

          {/* DOT Weight Limit Tracker */}
          <div className="bg-white p-3.5 rounded-xl border border-gray-150">
            <div className="flex justify-between text-[10px] mb-1 font-mono">
              <span className="font-bold text-gray-500 uppercase flex items-center">
                {truckType
                  ? t('truckBuilder.payloadGauge', { type: truckType })
                  : t('truckBuilder.trailerGauge')}
              </span>
              <span className={`font-black ${capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs ? 'text-red-600 animate-pulse' : 'text-ink-800'}`}>
                {capacityLimitLbs > 0
                  ? t('truckBuilder.weightCapacity', {
                      current: totalWeightSelected.toLocaleString(),
                      limit: capacityLimitLbs.toLocaleString(),
                      pct: limitPercentage
                    })
                  : t('truckBuilder.weightNoCapacity', {
                      current: totalWeightSelected.toLocaleString(),
                      hint: t('truckBuilder.selectTypeCapacity')
                    })}
              </span>
            </div>
            <div className="w-full bg-gray-100 h-2.5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs
                    ? 'bg-red-600'
                    : limitPercentage > 85
                    ? 'bg-amber-500'
                    : 'bg-ink-700'
                }`}
                style={{ width: capacityLimitLbs > 0 ? `${limitPercentage}%` : '0%' }}
              />
            </div>
            {capacityLimitLbs > 0 && totalWeightSelected > capacityLimitLbs && (
              <p className="text-[9px] text-red-600 font-bold mt-1.5 font-mono">
                {t('truckBuilder.overweightDetail', {
                  type: truckType || t('truckBuilder.selectedTrailer'),
                  limit: capacityLimitLbs.toLocaleString()
                })}
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
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || selectedOrderIds.length === 0}
              className={`px-5 py-2.5 text-xs font-bold rounded-xl shadow-md transition-all flex items-center space-x-1.5 ${
                selectedOrderIds.length === 0
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed shadow-none'
                  : 'bg-ink-700 hover:bg-ink-800 text-white'
              }`}
            >
              {saving ? (
                <span>{t('truckBuilder.saving')}</span>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>{truckToEdit ? t('trucks.updateTruck') : t('trucks.saveTruck')}</span>
                </>
              )}
            </button>
          </div>
          {selectedOrderIds.length === 0 && (
            <p className="text-[10px] text-gray-500 text-right font-mono">
              {t('trucks.selectOneOrder')}
            </p>
          )}
        </div>
      </form>
    </div>
  );
};
