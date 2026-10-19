import { CustomerOrder, Truck } from '../types';
import { parseDateKey, toDateKey } from './dates';
import { orderRefLabel } from './orderLabels';
import { AppPermissions } from './permissions';

export const DIRECT_SHIP_TRUCK_PREFIX = 'direct-ship-';

export function isDirectShipBoardTruckId(id: string | null | undefined): boolean {
  return String(id || '').startsWith(DIRECT_SHIP_TRUCK_PREFIX);
}

export function directShipOrderIdFromBoardTruck(id: string): string {
  return id.slice(DIRECT_SHIP_TRUCK_PREFIX.length);
}

/** One day-board card per direct-ship order. Not a saved truck. */
export function directShipBoardTrucks(orders: CustomerOrder[], label = 'Direct ship'): Truck[] {
  return orders
    .filter((order) => isDirectShipOrder(order) && !order.truckId)
    .map((order) => {
      const created = new Date(order.dateCreated);
      const loadingDate = parseDateKey(order.directShipDate || '')
        ? order.directShipDate!
        : Number.isNaN(created.getTime())
          ? toDateKey(new Date())
          : toDateKey(created);
      const ref = orderRefLabel(order);
      return {
        id: `${DIRECT_SHIP_TRUCK_PREFIX}${order.id}`,
        name: ref
          ? `${label} · ${order.customerName} · ${ref}`
          : `${label} · ${order.customerName}`,
        dateCreated: order.dateCreated,
        status: order.status,
        orderIds: [order.id],
        loadingDate,
        truckType: label,
        notes: 'Direct ship — vendor to customer'
      };
    });
}

export function isDirectShipOrder(order: Pick<CustomerOrder, 'directShip'>): boolean {
  return order.directShip === true;
}

/** Hide direct-ship orders from yard and office roles; owner/admin only. */
export function filterOrdersForPermissions(
  orders: CustomerOrder[],
  permissions: Pick<AppPermissions, 'canViewDirectShipOrders'>
): CustomerOrder[] {
  if (permissions.canViewDirectShipOrders) return orders;
  return orders.filter((order) => !isDirectShipOrder(order));
}

/** Orders without a truck assignment can generate a standalone BOL from the order view. */
export function canGenerateStandaloneBol(order: Pick<CustomerOrder, 'truckId'>): boolean {
  return !order.truckId;
}

/** Synthetic truck for BOL generation when an order is not on a real truck. */
export function buildStandaloneBolTruck(order: CustomerOrder): Truck {
  const ref = orderRefLabel(order);
  const name = isDirectShipOrder(order)
    ? `Direct ship · ${order.customerName}`
    : ref
      ? `${order.customerName} · ${ref}`
      : order.customerName;

  return {
    id: `standalone-${order.id}`,
    name,
    dateCreated: order.dateCreated,
    status: order.status,
    orderIds: [order.id],
    loadingDate: new Date().toISOString().split('T')[0],
    notes: isDirectShipOrder(order) ? 'Direct ship — vendor to customer' : undefined
  };
}

/** @deprecated Use buildStandaloneBolTruck */
export function buildDirectShipBolTruck(order: CustomerOrder): Truck {
  return buildStandaloneBolTruck(order);
}
