import { CustomerOrder } from '../types';
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
