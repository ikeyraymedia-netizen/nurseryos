import React, { useState } from 'react';
import { Search, Calendar, Weight, Trash2, CheckCircle2, CircleDot, PlayCircle, MapPin, DollarSign } from 'lucide-react';
import { CustomerOrder } from '../types';
import { deleteCustomerOrder } from '../lib/db';

interface OrdersListProps {
  orders: CustomerOrder[];
  selectedOrderId: string | null;
  canDelete?: boolean;
  orderIdsNeedingInvoice?: Set<string>;
  onSelectOrder: (orderId: string) => void;
}

export const OrdersList: React.FC<OrdersListProps> = ({
  orders,
  selectedOrderId,
  canDelete = true,
  orderIdsNeedingInvoice,
  onSelectOrder
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'loading' | 'completed'>('all');
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);

  const handleDeleteConfirm = async (orderId: string) => {
    try {
      await deleteCustomerOrder(orderId);
      setDeletingOrderId(null);
    } catch (err) {
      console.error('Failed to delete order:', err);
    }
  };

  // Filter orders based on search query and status filter
  const filteredOrders = orders.filter((order) => {
    const matchesSearch =
      order.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      order.orderNumber.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: CustomerOrder['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            Loaded / Ready
          </span>
        );
      case 'loading':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 animate-pulse">
            <PlayCircle className="h-3.5 w-3.5 mr-1" />
            In Progress
          </span>
        );
      case 'pending':
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <CircleDot className="h-3.5 w-3.5 mr-1" />
            To Load
          </span>
        );
    }
  };

  const getOrderProgress = (order: CustomerOrder) => {
    const totalQty = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const loadedQty = order.items.reduce((sum, item) => sum + item.loadedQuantity, 0);
    const percentage = totalQty > 0 ? Math.round((loadedQty / totalQty) * 100) : 0;
    return { totalQty, loadedQty, percentage };
  };

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Unknown date';
    }
  };

  return (
    <div id="orders-list-card" className="bg-white rounded-2xl shadow-md border-t-4 border-t-emerald-700 border-x border-b border-slate-200/95 p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-gray-900 font-sans">Plant Orders</h3>
        <span className="text-xs font-mono bg-emerald-100 text-emerald-950 border border-emerald-300 px-2.5 py-1 rounded-lg font-bold">
          {filteredOrders.length} {filteredOrders.length === 1 ? 'Order' : 'Orders'}
        </span>
      </div>

      {/* Search Input */}
      <div className="relative mb-4">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Search className="h-4 w-4 text-slate-500" />
        </div>
        <input
          type="text"
          placeholder="Search customer or order #..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:border-emerald-600 bg-slate-50/50 focus:bg-white transition-all font-medium text-gray-800 placeholder:text-slate-400 shadow-inner"
        />
      </div>

      {/* Filter Tabs */}
      <div className="flex border-b border-slate-300/80 pb-2 mb-4 overflow-x-auto gap-1">
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
            {tab === 'all' ? 'All Orders' : tab === 'loading' ? 'Loading' : tab === 'completed' ? 'Shipped' : 'Pending'}
          </button>
        ))}
      </div>

      {/* Orders Scroller */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[500px] lg:max-h-[600px] min-h-[300px]">
        {filteredOrders.length === 0 ? (
          <div className="text-center py-12 bg-slate-50/50 rounded-xl border border-dashed border-slate-300">
            <p className="text-sm font-semibold text-gray-700">No orders found</p>
            <p className="text-xs text-slate-500 mt-1 max-w-[200px] mx-auto leading-normal">
              {searchQuery || statusFilter !== 'all'
                ? 'Try adjusting your filters or search terms.'
                : 'Upload a PDF or image order in the sidebar to get started.'}
            </p>
          </div>
        ) : (
          filteredOrders.map((order) => {
            const isSelected = order.id === selectedOrderId;
            const { totalQty, loadedQty, percentage } = getOrderProgress(order);

            return (
              <div
                key={order.id}
                onClick={() => onSelectOrder(order.id)}
                className={`group relative border-2 rounded-xl p-4 cursor-pointer transition-all duration-150 flex flex-col justify-between ${
                  isSelected
                    ? 'border-emerald-600 bg-emerald-50/40 shadow-sm ring-1 ring-emerald-500/20'
                    : 'border-slate-200/90 bg-white hover:border-emerald-600 hover:bg-emerald-50/10 hover:shadow-md shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-sm font-black text-gray-900 font-sans truncate pr-4">
                      {order.customerName}
                    </h4>
                    <p className="text-xs text-slate-500 font-mono mt-0.5 font-bold">
                      Order #: {order.orderNumber}
                    </p>
                  </div>
                  {canDelete &&
                    (deletingOrderId === order.id ? (
                    <div className="flex items-center space-x-1 shrink-0 z-10">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteConfirm(order.id);
                        }}
                        className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold shadow-sm transition-all"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingOrderId(null);
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
                        setDeletingOrderId(order.id);
                      }}
                      className="text-gray-400 hover:text-red-600 p-1.5 rounded-md hover:bg-red-50 transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                      title="Delete order"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ))}
                </div>

                {/* Status & Date & Weight */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2.5 pt-2.5 border-t border-gray-100/70 text-[11px] text-gray-500 font-mono">
                  <span className="shrink-0">{getStatusBadge(order.status)}</span>
                  {orderIdsNeedingInvoice?.has(order.id) && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                      <DollarSign className="h-3 w-3 mr-0.5" />
                      Invoice not saved
                    </span>
                  )}
                  <span className="flex items-center shrink-0">
                    <Weight className="h-3.5 w-3.5 mr-1 text-gray-400" />
                    {order.totalWeightLbs.toLocaleString()} lbs
                  </span>
                  <span className="flex items-center shrink-0">
                    <Calendar className="h-3.5 w-3.5 mr-1 text-gray-400" />
                    {formatDate(order.dateCreated)}
                  </span>
                </div>

                {/* Staging Location Badge */}
                {order.stagedLocation && (
                  <div className="mt-2 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1 flex items-center space-x-1.5 w-fit">
                    <MapPin className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                    <span className="truncate">Staged at: <span className="font-black text-slate-900">{order.stagedLocation}</span></span>
                  </div>
                )}

                {/* Progress Bar */}
                <div className="mt-3">
                  <div className="flex justify-between items-center text-[11px] mb-1">
                    <span className="font-semibold text-gray-600">
                      Loaded: <span className="font-bold text-gray-900">{loadedQty}</span> of {totalQty} plants
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
    </div>
  );
};
