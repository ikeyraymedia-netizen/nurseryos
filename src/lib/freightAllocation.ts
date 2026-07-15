import { CustomerOrder } from '../types';

export type FreightAllocationMethod = 'equal' | 'truckUsage';

export interface FreightShare {
  orderId: string;
  amount: number;
  percentage: number;
}

/**
 * Allocate an exact currency total across truck orders. Rounding remainders are
 * assigned one cent at a time so shares always add back to the entered total.
 */
export function allocateFreight(
  totalFreight: number,
  orders: CustomerOrder[],
  method: FreightAllocationMethod
): FreightShare[] {
  if (orders.length === 0) return [];

  const totalCents = Math.max(0, Math.round(totalFreight * 100));
  const weights =
    method === 'truckUsage'
      ? orders.map((order) => Math.max(0, order.totalWeightLbs || 0))
      : orders.map(() => 1);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights = weightTotal > 0 ? weights : orders.map(() => 1);
  const effectiveTotal = effectiveWeights.reduce((sum, weight) => sum + weight, 0);

  const rawShares = effectiveWeights.map((weight) => (totalCents * weight) / effectiveTotal);
  const cents = rawShares.map(Math.floor);
  let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);

  const remainderOrder = rawShares
    .map((raw, index) => ({ index, fraction: raw - Math.floor(raw) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; i < remainder; i += 1) {
    cents[remainderOrder[i % remainderOrder.length].index] += 1;
  }

  return orders.map((order, index) => ({
    orderId: order.id,
    amount: cents[index] / 100,
    percentage:
      effectiveTotal > 0 ? (effectiveWeights[index] / effectiveTotal) * 100 : 100 / orders.length
  }));
}
