import { CustomerOrder, InventoryPlant, Truck } from '../types';
import { normalizeContainerSize, normalizePlantName, plantNamesMatch } from './inventoryMatch';
import { toDateKey, addDaysToDateKey } from './dates';

export interface LowStockAlert {
  plantName: string;
  containerSize: string;
  needed: number;
  available: number;
  shortfall: number;
  truckNames: string[];
  loadingDates: string[];
}

function demandKey(plantName: string, containerSize: string): string {
  return `${normalizePlantName(plantName)}::${normalizeContainerSize(containerSize)}`;
}

function findInventoryQty(
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string
): { qty: number; matchedName: string; matchedSize: string } {
  const size = normalizeContainerSize(containerSize);
  let best: InventoryPlant | null = null;
  for (const plant of plants) {
    if (normalizeContainerSize(plant.containerSize) !== size) continue;
    if (!plantNamesMatch(plantName, plant.plantName)) continue;
    if (!best) {
      best = plant;
      continue;
    }
    // Prefer exact normalized name match
    if (normalizePlantName(plant.plantName) === normalizePlantName(plantName)) {
      best = plant;
    }
  }
  if (!best) return { qty: 0, matchedName: plantName, matchedSize: containerSize };
  return {
    qty: best.quantityAvailable,
    matchedName: best.plantName,
    matchedSize: best.containerSize
  };
}

/** Trucks loading from today through the next `horizonDays` days (inclusive). */
export function buildLowStockForUpcomingTrucks(params: {
  trucks: Truck[];
  orders: CustomerOrder[];
  inventory: InventoryPlant[];
  horizonDays?: number;
  today?: string;
}): LowStockAlert[] {
  const horizonDays = params.horizonDays ?? 14;
  const today = params.today || toDateKey(new Date());
  const end = addDaysToDateKey(today, horizonDays);

  const upcomingTrucks = params.trucks.filter((truck) => {
    const date = (truck.loadingDate || '').trim();
    if (!date) return false;
    return date >= today && date <= end;
  });

  type Agg = {
    plantName: string;
    containerSize: string;
    needed: number;
    truckNames: Set<string>;
    loadingDates: Set<string>;
  };

  const demand = new Map<string, Agg>();

  for (const truck of upcomingTrucks) {
    const truckOrders = params.orders.filter(
      (o) => truck.orderIds.includes(o.id) || o.truckId === truck.id
    );
    for (const order of truckOrders) {
      for (const item of order.items) {
        const key = demandKey(item.plantName, item.containerSize);
        const existing = demand.get(key);
        if (existing) {
          existing.needed += item.quantity;
          existing.truckNames.add(truck.name);
          if (truck.loadingDate) existing.loadingDates.add(truck.loadingDate);
        } else {
          demand.set(key, {
            plantName: item.plantName,
            containerSize: item.containerSize,
            needed: item.quantity,
            truckNames: new Set([truck.name]),
            loadingDates: new Set(truck.loadingDate ? [truck.loadingDate] : [])
          });
        }
      }
    }
  }

  const alerts: LowStockAlert[] = [];
  for (const agg of demand.values()) {
    const inv = findInventoryQty(params.inventory, agg.plantName, agg.containerSize);
    if (inv.qty >= agg.needed) continue;
    alerts.push({
      plantName: inv.matchedName !== agg.plantName ? `${agg.plantName} → ${inv.matchedName}` : agg.plantName,
      containerSize: agg.containerSize,
      needed: agg.needed,
      available: inv.qty,
      shortfall: agg.needed - inv.qty,
      truckNames: [...agg.truckNames].sort(),
      loadingDates: [...agg.loadingDates].sort()
    });
  }

  return alerts.sort((a, b) => b.shortfall - a.shortfall || a.plantName.localeCompare(b.plantName));
}
