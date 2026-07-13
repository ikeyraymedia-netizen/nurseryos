import React, { useMemo, useState } from 'react';
import {
  Search,
  Calendar,
  Weight,
  Trash2,
  CheckCircle2,
  CircleDot,
  PlayCircle,
  Plus,
  Truck as TruckIcon,
  ChevronLeft,
  ChevronRight,
  ArrowLeft
} from 'lucide-react';
import { CustomerOrder, Truck } from '../types';
import { deleteTruck } from '../lib/db';
import { getTruckWeightCapacity, calculateWeightPercentage, getCapacitySeverity } from '../lib/capacity';
import {
  addDaysToDateKey,
  formatDayChipLabel,
  startOfWeekSunday,
  toDateKey,
  weekDateKeysFromSunday
} from '../lib/dates';

interface TrucksListProps {
  trucks: Truck[];
  orders: CustomerOrder[];
  selectedTruckId: string | null;
  canDelete?: boolean;
  canCreate?: boolean;
  onStartBuild: () => void;
  onSelectTruck: (truckId: string | null) => void;
}

type DaySelection = string | 'unscheduled';

export const TrucksList: React.FC<TrucksListProps> = ({
  trucks,
  orders,
  selectedTruckId,
  canDelete = true,
  canCreate = true,
  onStartBuild,
  onSelectTruck
}) => {
  const todayKey = toDateKey(new Date());
  const [weekStart, setWeekStart] = useState(() => startOfWeekSunday());
  const [selectedDay, setSelectedDay] = useState<DaySelection | null>(() => {
    const start = startOfWeekSunday();
    const days = weekDateKeysFromSunday(start);
    return days.includes(todayKey) ? todayKey : null;
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'loading' | 'completed'>('all');
  const [deletingTruckId, setDeletingTruckId] = useState<string | null>(null);

  const weekDays = useMemo(() => weekDateKeysFromSunday(weekStart), [weekStart]);

  const trucksByLoadingDate = useMemo(() => {
    const map: Record<string, Truck[]> = {};
    for (const day of weekDays) map[day] = [];
    const unscheduled: Truck[] = [];

    for (const truck of trucks) {
      const key = (truck.loadingDate || '').trim();
      if (!key) {
        unscheduled.push(truck);
        continue;
      }
      if (!map[key]) map[key] = [];
      map[key].push(truck);
    }
    return { map, unscheduled };
  }, [trucks, weekDays]);

  const handleDeleteConfirm = async (truckId: string) => {
    try {
      await deleteTruck(truckId);
      if (selectedTruckId === truckId) {
        onSelectTruck(null);
      }
      setDeletingTruckId(null);
    } catch (err) {
      console.error('Failed to delete truck:', err);
    }
  };

  const getTruckStats = (truck: Truck) => {
    const assignedOrders = orders.filter((o) => truck.orderIds.includes(o.id) || o.truckId === truck.id);
    let totalQty = 0;
    let loadedQty = 0;
    let totalWeight = 0;

    assignedOrders.forEach((order) => {
      totalWeight += order.totalWeightLbs;
      order.items.forEach((item) => {
        totalQty += item.quantity;
        loadedQty += item.loadedQuantity;
      });
    });

    const percentage = totalQty > 0 ? Math.round((loadedQty / totalQty) * 100) : 0;
    const capacity = getTruckWeightCapacity(truck.truckType);
    const overallWeightPercentage = calculateWeightPercentage(totalWeight, truck.truckType);

    let status: 'pending' | 'loading' | 'completed' = 'pending';
    if (loadedQty > 0) {
      status = loadedQty >= totalQty ? 'completed' : 'loading';
    }

    return {
      orderCount: assignedOrders.length,
      totalQty,
      loadedQty,
      totalWeight,
      percentage,
      capacity,
      overallWeightPercentage,
      status
    };
  };

  const dayTrucks = useMemo(() => {
    if (!selectedDay) return [];
    if (selectedDay === 'unscheduled') return trucksByLoadingDate.unscheduled;
    return trucksByLoadingDate.map[selectedDay] || [];
  }, [selectedDay, trucksByLoadingDate]);

  const filteredTrucks = dayTrucks.filter((truck) => {
    const stats = getTruckStats(truck);

    const matchesSearch =
      truck.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (truck.carrier && truck.carrier.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (truck.truckType && truck.truckType.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === 'all' || stats.status === statusFilter;

    return !!(matchesSearch && matchesStatus);
  });

  const getStatusBadge = (status: 'pending' | 'loading' | 'completed') => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Fully Loaded
          </span>
        );
      case 'loading':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 animate-pulse">
            <PlayCircle className="h-3 w-3 mr-1" />
            Loading
          </span>
        );
      case 'pending':
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <CircleDot className="h-3 w-3 mr-1" />
            Ready to Load
          </span>
        );
    }
  };

  const formatLoadingDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr + 'T00:00:00');
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  };

  const getOwnerBadgeStyle = (ownerName: string) => {
    switch (ownerName) {
      case 'Ikey':
        return 'bg-teal-50 text-teal-700 border-teal-200';
      case 'Nathan':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'Michael':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      default:
        return 'bg-gray-50 text-gray-700 border-gray-200';
    }
  };

  const selectedDayLabel =
    selectedDay === 'unscheduled'
      ? 'Unscheduled'
      : selectedDay
        ? formatLoadingDate(selectedDay)
        : null;

  return (
    <div id="trucks-list-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-emerald-700 border-x border-b border-slate-200/95 p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-gray-900 font-sans">Trucks by day</h3>
        {canCreate && (
          <button
            onClick={onStartBuild}
            className="inline-flex items-center px-2.5 py-1.5 rounded-xl text-xs font-black bg-emerald-700 text-white hover:bg-emerald-800 transition-colors shadow-sm"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Build Truck
          </button>
        )}
      </div>

      {/* Week navigator */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <button
          type="button"
          onClick={() => {
            setWeekStart(addDaysToDateKey(weekStart, -7));
            setSelectedDay(null);
          }}
          className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          title="Previous week"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            const start = startOfWeekSunday();
            setWeekStart(start);
            const days = weekDateKeysFromSunday(start);
            setSelectedDay(days.includes(todayKey) ? todayKey : null);
          }}
          className="text-[11px] font-bold text-emerald-800 hover:underline"
        >
          This week
        </button>
        <button
          type="button"
          onClick={() => {
            setWeekStart(addDaysToDateKey(weekStart, 7));
            setSelectedDay(null);
          }}
          className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          title="Next week"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Sun–Sat day board */}
      <div className="grid grid-cols-7 gap-1 mb-3">
        {weekDays.map((day) => {
          const count = (trucksByLoadingDate.map[day] || []).length;
          const labels = formatDayChipLabel(day);
          const isToday = day === todayKey;
          const isSelected = selectedDay === day;
          return (
            <button
              key={day}
              type="button"
              onClick={() => setSelectedDay(day)}
              className={`flex flex-col items-center rounded-xl px-0.5 py-2 border transition-all min-h-[68px] ${
                isSelected
                  ? 'bg-emerald-700 border-emerald-800 text-white shadow-sm'
                  : isToday
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-950 hover:bg-emerald-100'
                    : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-emerald-300 hover:bg-emerald-50/50'
              }`}
            >
              <span className={`text-[9px] font-black uppercase tracking-wide ${isSelected ? 'text-emerald-100' : 'text-slate-500'}`}>
                {labels.weekday}
              </span>
              <span className="text-[10px] font-bold leading-tight mt-0.5">{labels.monthDay.replace(/^.+ /, '')}</span>
              <span
                className={`mt-1 text-[10px] font-black rounded-full min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center ${
                  isSelected
                    ? 'bg-white/20 text-white'
                    : count > 0
                      ? 'bg-emerald-100 text-emerald-900'
                      : 'bg-slate-200/70 text-slate-500'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {trucksByLoadingDate.unscheduled.length > 0 && (
        <button
          type="button"
          onClick={() => setSelectedDay('unscheduled')}
          className={`mb-3 w-full text-left text-[11px] font-bold rounded-xl px-3 py-2 border transition-colors ${
            selectedDay === 'unscheduled'
              ? 'bg-amber-100 border-amber-300 text-amber-950'
              : 'bg-amber-50/60 border-amber-200 text-amber-900 hover:bg-amber-50'
          }`}
        >
          Unscheduled ({trucksByLoadingDate.unscheduled.length}) — no loading date set
        </button>
      )}

      {!selectedDay ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-10 px-4 bg-slate-50/60 rounded-xl border border-dashed border-slate-300 min-h-[220px]">
          <Calendar className="h-8 w-8 text-emerald-700 mb-3" />
          <p className="text-sm font-bold text-gray-800">Pick a day</p>
          <p className="text-xs text-slate-500 mt-1 max-w-[220px] leading-relaxed">
            Tap Sun–Sat above to see trucks scheduled to load that day. Set the loading date when you build a truck.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 mb-3">
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Week board
            </button>
            <p className="text-xs font-black text-gray-900 truncate">
              {selectedDayLabel}
              <span className="text-slate-400 font-bold ml-1">
                · {filteredTrucks.length} truck{filteredTrucks.length === 1 ? '' : 's'}
              </span>
            </p>
          </div>

          <div className="relative mb-3">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-500" />
            </div>
            <input
              type="text"
              placeholder="Search truck or carrier..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:border-emerald-600 bg-slate-50/50 focus:bg-white transition-all font-medium text-gray-800 placeholder:text-slate-400 shadow-inner"
            />
          </div>

          <div className="flex border-b border-slate-300/80 pb-2 mb-3 overflow-x-auto gap-1">
            {(['all', 'pending', 'loading', 'completed'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg capitalize whitespace-nowrap transition-all duration-150 ${
                  statusFilter === tab
                    ? 'bg-emerald-700 text-white shadow-sm'
                    : 'text-slate-600 hover:text-emerald-800 hover:bg-emerald-50'
                }`}
              >
                {tab === 'all' ? 'All' : tab === 'loading' ? 'Loading' : tab === 'completed' ? 'Loaded' : 'Pending'}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[500px] lg:max-h-[600px] min-h-[220px]">
            {filteredTrucks.length === 0 ? (
              <div className="text-center py-12 bg-slate-50/50 rounded-xl border border-dashed border-slate-300">
                <p className="text-sm font-semibold text-gray-700">No trucks this day</p>
                <p className="text-xs text-slate-500 mt-1 max-w-[200px] mx-auto leading-normal">
                  {searchQuery || statusFilter !== 'all'
                    ? 'Try adjusting your filters or search terms.'
                    : canCreate
                      ? 'Build a truck and set this loading date to see it here.'
                      : 'Nothing scheduled for this day yet.'}
                </p>
              </div>
            ) : (
              filteredTrucks.map((truck) => {
                const isSelected = truck.id === selectedTruckId;
                const {
                  orderCount,
                  totalQty,
                  loadedQty,
                  totalWeight,
                  percentage,
                  capacity,
                  overallWeightPercentage,
                  status
                } = getTruckStats(truck);
                const weightSeverity = getCapacitySeverity(totalWeight, truck.truckType);
                const isOver = weightSeverity === 'critical';

                return (
                  <div
                    key={truck.id}
                    onClick={() => onSelectTruck(truck.id)}
                    className={`group relative border-2 rounded-xl p-4 cursor-pointer transition-all duration-150 flex flex-col justify-between ${
                      isSelected
                        ? isOver
                          ? 'border-red-600 bg-red-50/50 shadow-sm ring-1 ring-red-500/20'
                          : 'border-emerald-600 bg-emerald-50/40 shadow-sm ring-1 ring-emerald-500/20'
                        : isOver
                          ? 'border-red-300 bg-red-50/30 hover:border-red-500 hover:shadow-md shadow-sm'
                          : 'border-slate-200/90 bg-white hover:border-emerald-600 hover:bg-emerald-50/10 hover:shadow-md shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="text-sm font-black text-gray-900 font-sans pr-4 flex items-center flex-wrap gap-1.5">
                          <TruckIcon className="h-4 w-4 text-emerald-850 shrink-0" />
                          <span className="truncate">{truck.name}</span>
                          {truck.owner && (
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black border ${getOwnerBadgeStyle(truck.owner)}`}
                            >
                              {truck.owner}
                            </span>
                          )}
                        </h4>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                          {truck.carrier && (
                            <p className="text-xs text-gray-500 font-medium">Carrier: {truck.carrier}</p>
                          )}
                          {truck.truckType && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 font-mono text-[10px] border border-emerald-100/30 font-bold">
                              {truck.truckType}
                            </span>
                          )}
                        </div>
                      </div>
                      {canDelete &&
                        (deletingTruckId === truck.id ? (
                          <div className="flex items-center space-x-1 shrink-0 z-10">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteConfirm(truck.id);
                              }}
                              className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold shadow-sm transition-all"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeletingTruckId(null);
                              }}
                              className="px-2 py-1 bg-gray-150 hover:bg-gray-200 text-gray-700 rounded-lg text-[10px] font-bold transition-all"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingTruckId(truck.id);
                            }}
                            className="text-gray-400 hover:text-red-600 p-1.5 rounded-md hover:bg-red-50 transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                            title="Delete truck"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 pt-2 border-t border-gray-100/70 text-[11px] text-gray-500 font-mono">
                      <span className="shrink-0">{getStatusBadge(status)}</span>
                      <span className="shrink-0 font-bold text-gray-700">
                        {orderCount} {orderCount === 1 ? 'order' : 'orders'}
                      </span>
                      <span
                        className="flex items-center shrink-0"
                        title={
                          capacity > 0
                            ? `Capacity: ${capacity.toLocaleString()} lbs (${overallWeightPercentage}% full)`
                            : undefined
                        }
                      >
                        <Weight className={`h-3.5 w-3.5 mr-0.5 ${isOver ? 'text-red-600' : 'text-gray-400'}`} />
                        {totalWeight.toLocaleString()} lbs
                        {capacity > 0 && (
                          <span
                            className={`ml-1 text-[10px] font-bold px-1.5 py-0.2 rounded font-sans shrink-0 border ${
                              isOver
                                ? 'text-red-900 bg-red-100 border-red-300'
                                : weightSeverity === 'warn'
                                  ? 'text-amber-900 bg-amber-50 border-amber-300'
                                  : 'text-amber-800 bg-amber-50 border-amber-200'
                            }`}
                          >
                            {isOver
                              ? `OVERWEIGHT ${overallWeightPercentage}%`
                              : `${overallWeightPercentage}% capacity`}
                          </span>
                        )}
                      </span>
                      {truck.loadingDate ? (
                        <span className="flex items-center shrink-0 bg-amber-50 text-amber-900 border border-amber-200 px-1.5 py-0.5 rounded text-[10px] font-bold">
                          <Calendar className="h-3 w-3 mr-1 text-amber-700" />
                          Loading: {formatLoadingDate(truck.loadingDate)}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-3">
                      {isOver && (
                        <p className="text-[11px] font-bold text-red-800 bg-red-100 border border-red-200 rounded-lg px-2 py-1.5 mb-2 leading-snug">
                          Overweight — {totalWeight.toLocaleString()} lbs on a {capacity.toLocaleString()} lb{' '}
                          {truck.truckType || 'trailer'}. Split orders or use a larger truck before loading.
                        </p>
                      )}
                      <div className="flex justify-between items-center text-[10px] mb-1">
                        <span className="font-semibold text-gray-600">
                          Loaded: <span className="font-bold text-gray-900">{loadedQty}</span>/{totalQty} pots
                        </span>
                        <span className="font-bold text-emerald-800 font-mono">{percentage}%</span>
                      </div>
                      <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-emerald-700 h-full rounded-full transition-all duration-300"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
};
