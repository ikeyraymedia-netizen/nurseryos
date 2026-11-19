import { CustomerOrder, Truck } from '../types';

export const DIRECT_SHIP_TRUCK_TYPE = 'Direct ship';

export function isDirectShipTruck(
  truck: Pick<Truck, 'directShip' | 'truckType'> | null | undefined
): boolean {
  return Boolean(truck && (truck.directShip || truck.truckType === DIRECT_SHIP_TRUCK_TYPE));
}

/** Orders that can be checked onto this truck. */
export function ordersSelectableForTruck(
  orders: CustomerOrder[],
  trucks: Truck[],
  editingTruckId: string | null,
  directShip: boolean
): CustomerOrder[] {
  return orders.filter((order) => {
    if (editingTruckId && order.truckId === editingTruckId) return true;
    if (!order.truckId) return directShip || order.directShip !== true;
    if (!directShip) return false;
    const host = trucks.find((truck) => truck.id === order.truckId);
    return isDirectShipTruck(host);
  });
}

/** Keep every order already on the truck when one order's ship date is saved. */
export function directShipTruckOrderIds(
  truck: Pick<Truck, 'orderIds'>,
  orderId: string
): string[] {
  const ids = truck.orderIds || [];
  return ids.includes(orderId) ? ids : [...ids, orderId];
}

export interface OrderTruckPatch {
  id: string;
  truckId: string | null;
  directShip?: boolean | null;
  directShipDate?: string | null;
}

/**
 * Move the chosen orders onto this truck.
 * A direct-ship truck that loses its last order is removed.
 * Orders left on a direct-ship truck are marked direct ship for the truck date.
 * Orders taken off a direct-ship truck go back to the normal unassigned list.
 */
export function planTruckOrderAssignment(input: {
  trucks: Truck[];
  truck: Truck;
  previousOrderIds: string[];
}): {
  trucks: Truck[];
  emptiedDirectShipTruckIds: string[];
  orderPatches: OrderTruckPatch[];
} {
  const previous = input.trucks.find((truck) => truck.id === input.truck.id);
  const wasDirect = isDirectShipTruck(previous);
  const wanted = new Set(input.truck.orderIds || []);
  const emptiedDirectShipTruckIds: string[] = [];
  const withSaved = previous
    ? input.trucks.map((truck) => (truck.id === input.truck.id ? input.truck : truck))
    : [input.truck, ...input.trucks];

  const trucks = withSaved.flatMap((truck) => {
    if (truck.id === input.truck.id) return [truck];
    const ids = truck.orderIds || [];
    if (!ids.some((id) => wanted.has(id))) return [truck];
    const remaining = ids.filter((id) => !wanted.has(id));
    if (remaining.length === 0 && isDirectShipTruck(truck)) {
      emptiedDirectShipTruckIds.push(truck.id);
      return [];
    }
    return [{ ...truck, orderIds: remaining }];
  });

  const date = String(input.truck.loadingDate || '').slice(0, 10);
  const orderPatches: OrderTruckPatch[] = [];
  for (const id of input.truck.orderIds || []) {
    if (input.truck.directShip) {
      orderPatches.push({
        id,
        truckId: input.truck.id,
        directShip: true,
        directShipDate: date
      });
    } else {
      orderPatches.push({
        id,
        truckId: input.truck.id,
        directShip: null,
        directShipDate: null
      });
    }
  }
  const nextIds = new Set(input.truck.orderIds || []);
  for (const id of input.previousOrderIds) {
    if (nextIds.has(id)) continue;
    if (wasDirect) {
      orderPatches.push({
        id,
        truckId: null,
        directShip: null,
        directShipDate: null
      });
    } else {
      orderPatches.push({ id, truckId: null });
    }
  }

  return { trucks, emptiedDirectShipTruckIds, orderPatches };
}

export function applyOrderTruckPatches(
  orders: CustomerOrder[],
  patches: OrderTruckPatch[]
): CustomerOrder[] {
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return orders.map((order) => {
    const patch = byId.get(order.id);
    if (!patch) return order;
    const next: CustomerOrder = { ...order, truckId: patch.truckId };
    if (patch.directShip === true) {
      next.directShip = true;
      next.directShipDate = patch.directShipDate || undefined;
    } else if (patch.directShip === null) {
      delete next.directShip;
      delete next.directShipDate;
    }
    return next;
  });
}
