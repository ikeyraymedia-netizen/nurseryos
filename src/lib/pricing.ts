import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import { ContainerWeight, InventoryPlant } from '../types';
import { findMatchingInventoryPlants } from './inventoryMatch';

/** Sensible default nursery wholesale pricing based on container size. */
export function getDefaultPriceForSize(size: string): number {
  const cleanSize = size.toLowerCase().trim();
  if (cleanSize.includes('#1') || cleanSize.includes('1-gallon') || cleanSize.includes('1g')) {
    return 6.5;
  }
  if (cleanSize.includes('#3') || cleanSize.includes('3-gallon') || cleanSize.includes('3g')) {
    return 16.5;
  }
  if (cleanSize.includes('#7') || cleanSize.includes('7-gallon') || cleanSize.includes('7g')) {
    return 38;
  }
  if (cleanSize.includes('#15') || cleanSize.includes('15-gallon') || cleanSize.includes('15g')) {
    return 85;
  }
  if (cleanSize.includes('#30') || cleanSize.includes('30-gallon') || cleanSize.includes('30g')) {
    return 195;
  }
  if (cleanSize.includes('#45') || cleanSize.includes('45-gallon') || cleanSize.includes('45g')) {
    return 275;
  }
  if (cleanSize.includes('#65') || cleanSize.includes('65-gallon') || cleanSize.includes('65g')) {
    return 375;
  }
  if (cleanSize.includes('#100') || cleanSize.includes('100-gallon') || cleanSize.includes('100g')) {
    return 550;
  }
  return 15;
}

/** Inventory list price when name+size match a stocked plant. */
export function inventoryListPriceForPlant(
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string,
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): number | null {
  if (!plantName.trim() || plants.length === 0) return null;
  const match = findMatchingInventoryPlants(plants, plantName, containerSize, weights)[0];
  if (!match || match.listPrice == null) return null;
  const n = Number(match.listPrice);
  return Number.isFinite(n) ? n : null;
}

/**
 * Preferred unit price for a line:
 * 1) explicit unitPrice on the line
 * 2) matched inventory listPrice
 * 3) size-based wholesale default
 */
export function resolveLineUnitPrice(
  item: { plantName: string; containerSize: string; unitPrice?: number | null },
  plants: InventoryPlant[] = [],
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): number {
  if (typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice)) {
    return item.unitPrice;
  }
  const fromInventory = inventoryListPriceForPlant(
    plants,
    item.plantName,
    item.containerSize,
    weights
  );
  if (fromInventory != null) return fromInventory;
  return getDefaultPriceForSize(item.containerSize);
}

/** Reset/default price ignoring any saved unitPrice (inventory → size default). */
export function defaultLineUnitPrice(
  item: { plantName: string; containerSize: string },
  plants: InventoryPlant[] = [],
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): number {
  const fromInventory = inventoryListPriceForPlant(
    plants,
    item.plantName,
    item.containerSize,
    weights
  );
  if (fromInventory != null) return fromInventory;
  return getDefaultPriceForSize(item.containerSize);
}
