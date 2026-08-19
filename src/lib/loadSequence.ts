import { CustomerOrder } from '../types';

export type TruckOrdersRef = { id: string; orderIds?: string[] };

export function truckOrderIds(truck?: TruckOrdersRef | null): string[] {
  return Array.isArray(truck?.orderIds) ? truck.orderIds : [];
}

/** 1-based load position. First in `orderIds` loads first. 0 if not on the truck. */
export function loadNumber(orderIds: string[], orderId: string): number {
  const index = orderIds.indexOf(orderId);
  return index === -1 ? 0 : index + 1;
}

/**
 * 1-based drop / stop position. Last loaded drops first (LIFO).
 * Load 1 of 3 drops 3rd; load 3 of 3 drops 1st.
 */
export function dropNumber(orderIds: string[], orderId: string): number {
  const index = orderIds.indexOf(orderId);
  if (index === -1 || orderIds.length === 0) return 0;
  return orderIds.length - index;
}

export function sortOrdersByLoadSequence<T extends { id: string; truckId?: string }>(
  orders: T[],
  truck?: TruckOrdersRef | null
): T[] {
  const ids = truckOrderIds(truck);
  const truckId = truck?.id;
  return [...orders]
    .filter((order) => ids.includes(order.id) || (truckId ? order.truckId === truckId : false))
    .sort((a, b) => {
      const idxA = ids.indexOf(a.id);
      const idxB = ids.indexOf(b.id);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
}

/** Delivery order: last loaded is first drop. */
export function sortOrdersByDropSequence<T extends { id: string; truckId?: string }>(
  orders: T[],
  truck?: TruckOrdersRef | null
): T[] {
  return [...sortOrdersByLoadSequence(orders, truck)].reverse();
}

export function truckCustomerOrders(
  orders: CustomerOrder[],
  truck?: TruckOrdersRef | null
): CustomerOrder[] {
  return sortOrdersByLoadSequence(orders, truck);
}
