import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { CustomerOrder, ContainerWeight, Truck } from '../types';
import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import {
  adjustInventoryForLoadDeltas,
  describeInventorySyncResult,
  inventorySyncSucceeded
} from './inventory';

let activeTenantId: string | null = null;

// Keep track of fallback state
let fallbackActive = false;
let fallbackReason: string | null = null;
const weightsListeners = new Set<(weights: ContainerWeight[]) => void>();
const ordersListeners = new Set<(orders: CustomerOrder[]) => void>();
const trucksListeners = new Set<(trucks: Truck[]) => void>();
/** While a write is in flight, prefer local order data over stale Firestore snapshots. */
const pendingOrderWriteIds = new Set<string>();

export function setActiveTenant(tenantId: string | null) {
  activeTenantId = tenantId;
  fallbackActive = false;
  fallbackReason = null;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected. Please sign in again.');
  }
  return activeTenantId;
}

function confirmedInventoryDeducted(item: {
  inventoryDeductedQty?: number;
  inventorySyncConfirmed?: boolean;
}): number {
  if (!item.inventorySyncConfirmed) return 0;
  return item.inventoryDeductedQty ?? 0;
}

async function syncInventoryAfterLoad(
  tenantId: string,
  deltas: Array<{ plantName: string; containerSize: string; delta: number }>
): Promise<{ message: string; ok: boolean }> {
  if (deltas.length === 0) {
    return { message: 'No inventory changes were needed.', ok: true };
  }
  try {
    const result = await adjustInventoryForLoadDeltas(deltas, tenantId);
    return {
      message: describeInventorySyncResult(result),
      ok: inventorySyncSucceeded(result)
    };
  } catch (err: any) {
    console.error('Inventory sync failed:', err);
    const msg = String(err?.message || err).toLowerCase();
    const code = String(err?.code || '').toLowerCase();
    if (code === 'permission-denied' || msg.includes('permission') || msg.includes('insufficient')) {
      return {
        message:
          'Inventory could not be updated. In Firebase Console → Firestore → Security, republish the latest security rules.',
        ok: false
      };
    }
    return {
      message: `Inventory could not be updated: ${err?.message || err}`,
      ok: false
    };
  }
}

function weightsCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'containerWeights');
}
function ordersCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'orders');
}
function trucksCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'trucks');
}
function weightDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'containerWeights', id);
}
function orderDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'orders', id);
}
function truckDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'trucks', id);
}

function localKey(suffix: string): string {
  const tenantId = activeTenantId || 'anonymous';
  return `nursery_${tenantId}_${suffix}`;
}

export function isUsingFallback(): boolean {
  return fallbackActive;
}

export function getFallbackReason(): string | null {
  return fallbackReason;
}

// --- LOCAL STORAGE HELPERS ---
function getLocalWeights(): ContainerWeight[] {
  const data = localStorage.getItem(localKey('container_weights'));
  if (data) {
    try {
      return JSON.parse(data) as ContainerWeight[];
    } catch {
      return DEFAULT_CONTAINER_WEIGHTS;
    }
  }
  localStorage.setItem(localKey('container_weights'), JSON.stringify(DEFAULT_CONTAINER_WEIGHTS));
  return DEFAULT_CONTAINER_WEIGHTS;
}

function saveLocalWeights(weights: ContainerWeight[]) {
  localStorage.setItem(localKey('container_weights'), JSON.stringify(weights));
  weightsListeners.forEach((cb) => cb(weights));
}

function getLocalOrders(): CustomerOrder[] {
  const data = localStorage.getItem(localKey('customer_orders'));
  if (data) {
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
  return [];
}

function saveLocalOrders(orders: CustomerOrder[]) {
  const sorted = [...orders].sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
  localStorage.setItem(localKey('customer_orders'), JSON.stringify(sorted));
  ordersListeners.forEach((cb) => cb(sorted));
}

function applyPendingLocalOrders(serverOrders: CustomerOrder[]): CustomerOrder[] {
  if (pendingOrderWriteIds.size === 0) return serverOrders;
  const localById = new Map(getLocalOrders().map((o) => [o.id, o]));
  return serverOrders.map((order) =>
    pendingOrderWriteIds.has(order.id) ? localById.get(order.id) ?? order : order
  );
}

function getLocalTrucks(): Truck[] {
  const data = localStorage.getItem(localKey('trucks'));
  if (data) {
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
  return [];
}

function saveLocalTrucks(trucks: Truck[]) {
  const sorted = [...trucks].sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
  localStorage.setItem(localKey('trucks'), JSON.stringify(sorted));
  trucksListeners.forEach((cb) => cb(sorted));
}

function activateLocalFallback(reason: string) {
  if (!fallbackActive) {
    console.warn(`⚠️ Switching to local storage fallback mode: ${reason}`);
    fallbackActive = true;
    fallbackReason = reason;

    const localW = getLocalWeights();
    const localO = getLocalOrders();
    const localT = getLocalTrucks();
    weightsListeners.forEach((cb) => cb(localW));
    ordersListeners.forEach((cb) => cb(localO));
    trucksListeners.forEach((cb) => cb(localT));
  } else {
    fallbackReason = reason;
  }
}

/**
 * Push browser-local orders/trucks to Firestore, clear offline mode, then reload.
 * Fixes loaders not seeing trucks built while this device was in Local Active mode.
 */
export async function reconnectAndSyncToCloud(): Promise<void> {
  const tenantId = requireTenantId();
  const localOrders = getLocalOrders();
  const localTrucks = getLocalTrucks();

  // Firestore batches max ~500 ops; chunk if needed
  const chunks: Array<() => Promise<void>> = [];
  let batch = writeBatch(db);
  let ops = 0;

  const flush = () => {
    if (ops === 0) return;
    const toCommit = batch;
    chunks.push(() => toCommit.commit());
    batch = writeBatch(db);
    ops = 0;
  };

  for (const order of localOrders) {
    batch.set(orderDoc(tenantId, order.id), order, { merge: true });
    ops += 1;
    if (ops >= 400) flush();
  }

  for (const truck of localTrucks) {
    batch.set(
      truckDoc(tenantId, truck.id),
      {
        name: truck.name,
        carrier: truck.carrier || '',
        truckType: truck.truckType || '',
        notes: truck.notes || '',
        loadingDate: truck.loadingDate || '',
        owner: truck.owner || '',
        dateCreated: truck.dateCreated,
        status: truck.status || 'pending',
        orderIds: truck.orderIds || []
      },
      { merge: true }
    );
    ops += 1;
    for (const orderId of truck.orderIds || []) {
      batch.set(orderDoc(tenantId, orderId), { truckId: truck.id }, { merge: true });
      ops += 1;
      if (ops >= 400) flush();
    }
    if (ops >= 400) flush();
  }
  flush();

  for (const commit of chunks) {
    await commit();
  }

  fallbackActive = false;
  fallbackReason = null;
  window.location.reload();
}

export async function initializeDefaultWeightsIfNeeded(): Promise<ContainerWeight[]> {
  const tenantId = requireTenantId();

  if (fallbackActive) {
    return getLocalWeights();
  }

  try {
    const querySnapshot = await getDocs(weightsCol(tenantId));

    if (querySnapshot.empty) {
      console.log('No container weights found. Initializing defaults...');
      const batch = writeBatch(db);
      for (const cw of DEFAULT_CONTAINER_WEIGHTS) {
        batch.set(weightDoc(tenantId, cw.id), cw);
      }
      await batch.commit();
      return DEFAULT_CONTAINER_WEIGHTS;
    }

    const weights: ContainerWeight[] = [];
    querySnapshot.forEach((docSnap) => {
      weights.push(docSnap.data() as ContainerWeight);
    });
    return weights;
  } catch (error: any) {
    console.error('Error initializing default container weights on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore connection failed');
    return getLocalWeights();
  }
}

// --- SUBSCRIBERS ---
export function subscribeToWeights(callback: (weights: ContainerWeight[]) => void) {
  weightsListeners.add(callback);

  if (!activeTenantId || fallbackActive) {
    callback(getLocalWeights());
    return () => {
      weightsListeners.delete(callback);
    };
  }

  const tenantId = activeTenantId;
  const unsubscribe = onSnapshot(
    weightsCol(tenantId),
    (snapshot) => {
      const weights: ContainerWeight[] = [];
      snapshot.forEach((docSnap) => {
        weights.push(docSnap.data() as ContainerWeight);
      });
      if (weights.length === 0) {
        initializeDefaultWeightsIfNeeded().then((initialized) => {
          callback(initialized);
        });
      } else {
        localStorage.setItem(localKey('container_weights'), JSON.stringify(weights));
        callback(weights);
      }
    },
    (error) => {
      console.error('Error subscribing to weights on Firestore:', error);
      activateLocalFallback(error.message || 'Firestore subscription failed');
    }
  );

  return () => {
    unsubscribe();
    weightsListeners.delete(callback);
  };
}

export function subscribeToOrders(callback: (orders: CustomerOrder[]) => void) {
  ordersListeners.add(callback);

  if (!activeTenantId || fallbackActive) {
    callback(getLocalOrders());
    return () => {
      ordersListeners.delete(callback);
    };
  }

  const tenantId = activeTenantId;
  const q = query(ordersCol(tenantId), orderBy('dateCreated', 'desc'));
  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const orders: CustomerOrder[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        orders.push({
          id: docSnap.id,
          ...data
        } as CustomerOrder);
      });
      const merged = applyPendingLocalOrders(orders);
      localStorage.setItem(localKey('customer_orders'), JSON.stringify(merged));
      callback(merged);
    },
    (error) => {
      console.error('Error subscribing to orders on Firestore:', error);
      activateLocalFallback(error.message || 'Firestore orders subscription failed');
    }
  );

  return () => {
    unsubscribe();
    ordersListeners.delete(callback);
  };
}

export function subscribeToTrucks(callback: (trucks: Truck[]) => void) {
  trucksListeners.add(callback);

  if (!activeTenantId || fallbackActive) {
    callback(getLocalTrucks());
    return () => {
      trucksListeners.delete(callback);
    };
  }

  const tenantId = activeTenantId;
  const q = query(trucksCol(tenantId), orderBy('dateCreated', 'desc'));
  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const trucks: Truck[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        trucks.push({
          id: docSnap.id,
          ...data
        } as Truck);
      });
      localStorage.setItem(localKey('trucks'), JSON.stringify(trucks));
      callback(trucks);
    },
    (error) => {
      console.error('Error subscribing to trucks on Firestore:', error);
      activateLocalFallback(error.message || 'Firestore trucks subscription failed');
    }
  );

  return () => {
    unsubscribe();
    trucksListeners.delete(callback);
  };
}

// --- MUTATIONS ---
export async function resetToFactoryWeights(): Promise<void> {
  const tenantId = requireTenantId();
  saveLocalWeights(DEFAULT_CONTAINER_WEIGHTS);
  if (fallbackActive) return;

  try {
    const batch = writeBatch(db);
    for (const cw of DEFAULT_CONTAINER_WEIGHTS) {
      batch.set(weightDoc(tenantId, cw.id), cw);
    }
    await batch.commit();
  } catch (error: any) {
    console.error('Error resetting weights in Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
  }
}

export async function updateContainerWeight(weight: ContainerWeight): Promise<void> {
  const tenantId = requireTenantId();
  const weights = getLocalWeights();
  const updated = weights.map((w) => (w.id === weight.id ? weight : w));
  saveLocalWeights(updated);

  if (fallbackActive) return;

  try {
    await setDoc(weightDoc(tenantId, weight.id), weight, { merge: true });
  } catch (error: any) {
    console.error('Error updating container weight on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
  }
}

export async function addCustomerOrder(order: Omit<CustomerOrder, 'id' | 'dateCreated'>): Promise<string> {
  const tenantId = requireTenantId();
  const newId = `order-${Date.now()}`;
  const dateCreated = new Date().toISOString();
  const fullOrder: CustomerOrder = {
    ...order,
    id: newId,
    dateCreated
  };

  const localOrders = getLocalOrders();
  saveLocalOrders([fullOrder, ...localOrders]);

  if (fallbackActive) {
    return newId;
  }

  try {
    await setDoc(orderDoc(tenantId, newId), fullOrder);
    return newId;
  } catch (error: any) {
    console.error('Error adding customer order to Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
    return newId;
  }
}

export async function updateOrderItemProgress(
  orderId: string,
  itemId: string,
  loadedQuantity: number,
  orderItems: any[],
  _totalItemsCount: number
): Promise<string> {
  const tenantId = requireTenantId();
  const currentItem = orderItems.find((item) => item.id === itemId);
  const inventoryDelta = currentItem ? loadedQuantity - confirmedInventoryDeducted(currentItem) : 0;
  const loadDelta =
    currentItem && inventoryDelta !== 0
      ? {
          plantName: currentItem.plantName,
          containerSize: currentItem.containerSize,
          delta: inventoryDelta
        }
      : null;

  let totalQuantity = 0;
  let totalLoaded = 0;
  const previewItems = orderItems.map((item) => {
    if (item.id === itemId) {
      return { ...item, loadedQuantity };
    }
    return item;
  });
  previewItems.forEach((item) => {
    totalQuantity += item.quantity;
    totalLoaded += item.loadedQuantity;
  });

  let status: 'pending' | 'loading' | 'completed' = 'pending';
  if (totalLoaded > 0) {
    status = totalLoaded >= totalQuantity ? 'completed' : 'loading';
  }

  const optimisticItems = orderItems.map((item) => {
    if (item.id !== itemId) return item;
    return { ...item, loadedQuantity };
  });

  const orders = getLocalOrders();
  const optimisticOrders = orders.map((o) => {
    if (o.id === orderId) {
      return { ...o, items: optimisticItems, status };
    }
    return o;
  });
  saveLocalOrders(optimisticOrders);

  if (fallbackActive) return 'Saved locally (offline mode).';

  pendingOrderWriteIds.add(orderId);

  try {
    let syncMessage = 'No inventory changes were needed.';
    let syncOk = true;
    if (loadDelta) {
      const sync = await syncInventoryAfterLoad(tenantId, [loadDelta]);
      syncMessage = sync.message;
      syncOk = sync.ok;
    }

    const updatedItems = orderItems.map((item) => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        loadedQuantity,
        inventoryDeductedQty: syncOk ? loadedQuantity : confirmedInventoryDeducted(item),
        inventorySyncConfirmed: syncOk ? true : item.inventorySyncConfirmed
      };
    });

    await updateDoc(orderDoc(tenantId, orderId), {
      items: updatedItems,
      status
    });

    const finalOrders = getLocalOrders().map((o) => {
      if (o.id === orderId) {
        return { ...o, items: updatedItems, status };
      }
      return o;
    });
    saveLocalOrders(finalOrders);
    return syncMessage;
  } catch (error: any) {
    console.error('Error updating item progress on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore update failed');
    return 'Load progress saved locally, but cloud sync failed.';
  } finally {
    pendingOrderWriteIds.delete(orderId);
  }
}

export async function updateOrderItemPulledProgress(
  orderId: string,
  itemId: string,
  pulledQuantity: number,
  orderItems: any[],
  _totalItemsCount: number
): Promise<void> {
  const tenantId = requireTenantId();
  const updatedItems = orderItems.map((item) => {
    if (item.id === itemId) {
      return { ...item, pulledQuantity };
    }
    return item;
  });

  pendingOrderWriteIds.add(orderId);
  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => {
    if (o.id === orderId) {
      return { ...o, items: updatedItems };
    }
    return o;
  });
  saveLocalOrders(updatedOrders);

  if (fallbackActive) {
    pendingOrderWriteIds.delete(orderId);
    return;
  }

  try {
    await updateDoc(orderDoc(tenantId, orderId), {
      items: updatedItems
    });
  } catch (error: any) {
    console.error('Error updating item pulled progress on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore update failed');
  } finally {
    pendingOrderWriteIds.delete(orderId);
  }
}

export async function updateOrderItemVendor(
  orderId: string,
  itemId: string,
  vendor: string,
  orderItems: any[]
): Promise<void> {
  const tenantId = requireTenantId();
  const updatedItems = orderItems.map((item) => {
    if (item.id === itemId) {
      return { ...item, vendor: vendor || undefined };
    }
    return item;
  });

  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => {
    if (o.id === orderId) {
      return { ...o, items: updatedItems };
    }
    return o;
  });
  saveLocalOrders(updatedOrders);

  if (fallbackActive) return;

  try {
    await updateDoc(orderDoc(tenantId, orderId), {
      items: updatedItems
    });
  } catch (error: any) {
    console.error('Error updating item vendor on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore update failed');
  }
}

export async function markAllItemsAsLoaded(orderId: string, orderItems: any[]): Promise<string> {
  const tenantId = requireTenantId();
  const inventoryDeltas = orderItems
    .map((item) => ({
      plantName: item.plantName,
      containerSize: item.containerSize,
      delta: item.quantity - confirmedInventoryDeducted(item)
    }))
    .filter((d) => d.delta !== 0);

  if (fallbackActive) return 'Saved locally (offline mode).';

  try {
    const sync = await syncInventoryAfterLoad(tenantId, inventoryDeltas);

    const updatedItems = orderItems.map((item) => ({
      ...item,
      pulledQuantity: item.quantity,
      loadedQuantity: item.quantity,
      inventoryDeductedQty: sync.ok ? item.quantity : confirmedInventoryDeducted(item),
      inventorySyncConfirmed: sync.ok ? true : item.inventorySyncConfirmed
    }));

    const orders = getLocalOrders();
    const updatedOrders = orders.map((o) => {
      if (o.id === orderId) {
        return { ...o, items: updatedItems, status: 'completed' as const };
      }
      return o;
    });
    saveLocalOrders(updatedOrders);

    await updateDoc(orderDoc(tenantId, orderId), {
      items: updatedItems,
      status: 'completed'
    });
    return sync.message;
  } catch (error: any) {
    console.error('Error marking all items loaded on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore update failed');
    return 'Order marked loaded locally, but cloud sync failed.';
  }
}

export async function resetOrderProgress(orderId: string, orderItems: any[]): Promise<string> {
  const tenantId = requireTenantId();
  const inventoryDeltas = orderItems
    .filter((item) => confirmedInventoryDeducted(item) > 0)
    .map((item) => ({
      plantName: item.plantName,
      containerSize: item.containerSize,
      delta: -confirmedInventoryDeducted(item)
    }));

  if (fallbackActive) return 'Saved locally (offline mode).';

  try {
    const sync = await syncInventoryAfterLoad(tenantId, inventoryDeltas);

    const updatedItems = orderItems.map((item) => ({
      ...item,
      pulledQuantity: 0,
      loadedQuantity: 0,
      inventoryDeductedQty: 0,
      inventorySyncConfirmed: false
    }));

    const orders = getLocalOrders();
    const updatedOrders = orders.map((o) => {
      if (o.id === orderId) {
        return { ...o, items: updatedItems, status: 'pending' as const };
      }
      return o;
    });
    saveLocalOrders(updatedOrders);

    await updateDoc(orderDoc(tenantId, orderId), {
      items: updatedItems,
      status: 'pending'
    });
    return sync.message;
  } catch (error: any) {
    console.error('Error resetting order progress on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore update failed');
    return 'Reset saved locally, but cloud sync failed.';
  }
}

export async function updateCustomerOrder(order: CustomerOrder): Promise<void> {
  const tenantId = requireTenantId();
  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => (o.id === order.id ? order : o));
  saveLocalOrders(updatedOrders);

  if (fallbackActive) return;

  try {
    await setDoc(orderDoc(tenantId, order.id), order, { merge: true });
  } catch (error: any) {
    console.error('Error updating customer order on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
  }
}

export async function deleteCustomerOrder(orderId: string): Promise<void> {
  const tenantId = requireTenantId();
  const orders = getLocalOrders();
  const filtered = orders.filter((o) => o.id !== orderId);
  saveLocalOrders(filtered);

  const trucks = getLocalTrucks();
  let affectedTruck: Truck | null = null;
  const updatedTrucks = trucks.map((t) => {
    if (t.orderIds.includes(orderId)) {
      const newOrderIds = t.orderIds.filter((id) => id !== orderId);
      affectedTruck = { ...t, orderIds: newOrderIds };
      return affectedTruck;
    }
    return t;
  });
  if (affectedTruck) {
    saveLocalTrucks(updatedTrucks);
  }

  if (fallbackActive) return;

  try {
    const batch = writeBatch(db);
    batch.delete(orderDoc(tenantId, orderId));

    if (affectedTruck) {
      batch.update(truckDoc(tenantId, (affectedTruck as Truck).id), {
        orderIds: (affectedTruck as Truck).orderIds
      });
    }

    await batch.commit();
  } catch (error: any) {
    console.error('Error deleting order on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore delete failed');
  }
}

export async function addTruck(truck: Omit<Truck, 'id' | 'dateCreated' | 'status'>): Promise<string> {
  const tenantId = requireTenantId();
  const newId = `truck-${Date.now()}`;
  const dateCreated = new Date().toISOString();
  const fullTruck: Truck = {
    ...truck,
    id: newId,
    dateCreated,
    status: 'pending'
  };

  const localTrucks = getLocalTrucks();
  saveLocalTrucks([fullTruck, ...localTrucks]);

  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => {
    if (truck.orderIds.includes(o.id)) {
      return { ...o, truckId: newId };
    }
    return o;
  });
  saveLocalOrders(updatedOrders);

  // Always attempt cloud write so loaders on other devices can see the truck.
  try {
    const activeOrderIds = new Set(getLocalOrders().map((o) => o.id));
    const batch = writeBatch(db);
    batch.set(truckDoc(tenantId, newId), {
      name: truck.name,
      carrier: truck.carrier || '',
      truckType: truck.truckType || '',
      notes: truck.notes || '',
      loadingDate: truck.loadingDate || '',
      owner: truck.owner || '',
      dateCreated,
      status: 'pending',
      orderIds: truck.orderIds
    });

    for (const orderId of truck.orderIds) {
      if (activeOrderIds.has(orderId)) {
        batch.update(orderDoc(tenantId, orderId), { truckId: newId });
      }
    }

    await batch.commit();
    fallbackActive = false;
    fallbackReason = null;
    return newId;
  } catch (error: any) {
    console.error('Error adding truck to Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
    throw new Error(
      'Truck saved on this device only — loaders will not see it until you sync. ' +
        'Click “Sync to cloud” in the header (Local Active), or check Firestore rules/connection. ' +
        `(${error?.message || 'cloud write failed'})`
    );
  }
}

export async function updateTruck(truck: Truck): Promise<void> {
  const tenantId = requireTenantId();
  const oldTrucks = getLocalTrucks();
  const oldTruck = oldTrucks.find((t) => t.id === truck.id);
  const oldOrderIds = oldTruck ? oldTruck.orderIds : [];

  const updatedTrucks = oldTrucks.map((t) => (t.id === truck.id ? truck : t));
  saveLocalTrucks(updatedTrucks);

  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => {
    if (truck.orderIds.includes(o.id)) {
      return { ...o, truckId: truck.id };
    } else if (oldOrderIds.includes(o.id)) {
      return { ...o, truckId: null };
    }
    return o;
  });
  saveLocalOrders(updatedOrders);

  try {
    const activeOrderIds = new Set(getLocalOrders().map((o) => o.id));
    const batch = writeBatch(db);
    batch.set(truckDoc(tenantId, truck.id), truck, { merge: true });

    for (const orderId of truck.orderIds) {
      if (!oldOrderIds.includes(orderId) && activeOrderIds.has(orderId)) {
        batch.update(orderDoc(tenantId, orderId), { truckId: truck.id });
      }
    }

    for (const orderId of oldOrderIds) {
      if (!truck.orderIds.includes(orderId) && activeOrderIds.has(orderId)) {
        batch.update(orderDoc(tenantId, orderId), { truckId: null });
      }
    }

    await batch.commit();
    fallbackActive = false;
    fallbackReason = null;
  } catch (error: any) {
    console.error('Error updating truck on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore write failed');
    throw new Error(
      'Truck changes saved on this device only — loaders may not see them. ' +
        'Click “Sync to cloud” in the header. ' +
        `(${error?.message || 'cloud write failed'})`
    );
  }
}

export async function deleteTruck(truckId: string): Promise<void> {
  const tenantId = requireTenantId();
  const oldTrucks = getLocalTrucks();
  const truckToDelete = oldTrucks.find((t) => t.id === truckId);
  const assignedOrderIds = truckToDelete ? truckToDelete.orderIds : [];

  const filteredTrucks = oldTrucks.filter((t) => t.id !== truckId);
  saveLocalTrucks(filteredTrucks);

  const orders = getLocalOrders();
  const updatedOrders = orders.map((o) => {
    if (o.truckId === truckId || assignedOrderIds.includes(o.id)) {
      return { ...o, truckId: null };
    }
    return o;
  });
  saveLocalOrders(updatedOrders);

  if (fallbackActive) return;

  try {
    const activeOrderIds = new Set(orders.map((o) => o.id));
    const batch = writeBatch(db);
    batch.delete(truckDoc(tenantId, truckId));

    for (const orderId of assignedOrderIds) {
      if (activeOrderIds.has(orderId)) {
        batch.update(orderDoc(tenantId, orderId), { truckId: null });
      }
    }

    await batch.commit();
  } catch (error: any) {
    console.error('Error deleting truck on Firestore:', error);
    activateLocalFallback(error.message || 'Firestore delete failed');
  }
}
