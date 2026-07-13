import {
  collection,
  getDocs,
  orderBy,
  query,
  where
} from 'firebase/firestore';
import { db } from '../firebase';
import { CustomerOrder, NurseryTask, Truck } from '../types';

export type WhatsNewKind = 'order' | 'truck' | 'task' | 'plant';

export interface WhatsNewItem {
  id: string;
  kind: WhatsNewKind;
  title: string;
  detail: string;
  at: string;
  mine?: boolean;
}

const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 40;

function storageKey(tenantId: string, userId: string) {
  return `nurseryos:lastSeen:${tenantId}:${userId}`;
}

export function getLastSeenAt(tenantId: string, userId: string): string | null {
  try {
    return localStorage.getItem(storageKey(tenantId, userId));
  } catch {
    return null;
  }
}

export function setLastSeenAt(tenantId: string, userId: string, iso = new Date().toISOString()) {
  try {
    localStorage.setItem(storageKey(tenantId, userId), iso);
  } catch {
    // ignore quota / private mode
  }
}

function after(iso: string, since: string): boolean {
  return iso > since;
}

export function buildWhatsNewDigest(params: {
  orders: CustomerOrder[];
  trucks: Truck[];
  tasks: NurseryTask[];
  since: string;
  userId: string;
}): WhatsNewItem[] {
  const floor = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
  const since = params.since > floor ? params.since : floor;
  const items: WhatsNewItem[] = [];

  for (const order of params.orders) {
    if (after(order.dateCreated, since)) {
      items.push({
        id: `order-${order.id}`,
        kind: 'order',
        title: `New order · ${order.customerName}`,
        detail: `Order #${order.orderNumber} · ${order.items.length} line${order.items.length === 1 ? '' : 's'}`,
        at: order.dateCreated
      });
      continue;
    }

    for (const line of order.items) {
      if (!line.addedAt || !after(line.addedAt, since)) continue;
      items.push({
        id: `plant-${order.id}-${line.id}`,
        kind: 'plant',
        title: `Plant added · ${order.customerName}`,
        detail: `${line.plantName} (${line.containerSize}) × ${line.quantity}${
          line.isAddition ? ' · addition' : ''
        }`,
        at: line.addedAt
      });
    }
  }

  for (const truck of params.trucks) {
    if (!after(truck.dateCreated, since)) continue;
    items.push({
      id: `truck-${truck.id}`,
      kind: 'truck',
      title: `New truck · ${truck.name}`,
      detail: [
        truck.loadingDate ? `Load ${truck.loadingDate}` : null,
        `${truck.orderIds.length} order${truck.orderIds.length === 1 ? '' : 's'}`
      ]
        .filter(Boolean)
        .join(' · '),
      at: truck.dateCreated
    });
  }

  for (const task of params.tasks) {
    if (!after(task.createdAt, since)) continue;
    items.push({
      id: `task-${task.id}`,
      kind: 'task',
      title: `New task · ${task.title}`,
      detail: `Assigned to ${task.assigneeName} · due ${task.dueDate}`,
      at: task.createdAt,
      mine: task.assigneeUserId === params.userId
    });
  }

  return items
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_ITEMS);
}

export async function listTasksCreatedSinceForTenant(
  tenantId: string,
  sinceIso: string
): Promise<NurseryTask[]> {
  const floor = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
  const since = sinceIso > floor ? sinceIso : floor;
  const col = collection(db, 'tenants', tenantId, 'tasks');
  try {
    const snap = await getDocs(
      query(col, where('createdAt', '>', since), orderBy('createdAt', 'desc'))
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NurseryTask, 'id'>) }));
  } catch (err) {
    console.warn('Could not load recent tasks for activity digest:', err);
    try {
      const snap = await getDocs(col);
      return snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<NurseryTask, 'id'>) }))
        .filter((t) => t.createdAt > since)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}
