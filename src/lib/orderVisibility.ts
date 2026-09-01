import { CustomerOrder, Truck } from '../types';
import { orderRefLabel } from './orderLabels';
import { AppPermissions } from './permissions';

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
