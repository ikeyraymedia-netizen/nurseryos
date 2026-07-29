import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  InventoryPlant,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStatus,
  VendorBill,
  VendorBillLine
} from '../types';
import {
  addInventoryPlant,
  updateInventoryPlant
} from './inventory';
import { findMatchingInventoryPlants } from './inventoryMatch';

let activeTenantId: string | null = null;

export function setPurchasingTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function sanitizeForFirestore<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForFirestore(item)) as T;
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value === undefined) continue;
      result[key] = sanitizeForFirestore(value);
    }
    return result as T;
  }
  return data;
}

function purchaseOrdersCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'purchaseOrders');
}

function purchaseOrderDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'purchaseOrders', id);
}

function vendorBillsCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'vendorBills');
}

function vendorBillDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'vendorBills', id);
}

const PO_NUMBER_START = 1000;
const BILL_NUMBER_START = 1000;

export function poLineSubtotal(items: PurchaseOrderLine[]): number {
  return items.reduce(
    (sum, item) => sum + (item.quantityOrdered || 0) * (item.unitCost || 0),
    0
  );
}

export function billLineSubtotal(items: VendorBillLine[]): number {
  return items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unitCost || 0),
    0
  );
}

export function derivePurchaseOrderStatus(items: PurchaseOrderLine[]): PurchaseOrderStatus {
  if (items.length === 0) return 'draft';
  const anyReceived = items.some((i) => (i.quantityReceived || 0) > 0);
  const allReceived = items.every(
    (i) => (i.quantityReceived || 0) >= (i.quantityOrdered || 0)
  );
  if (allReceived && anyReceived) return 'received';
  if (anyReceived) return 'partial';
  return 'sent';
}

async function nextPoNumber(tenantId: string): Promise<string> {
  const snap = await getDocs(purchaseOrdersCol(tenantId));
  let max = PO_NUMBER_START;
  snap.forEach((docSnap) => {
    const raw = String((docSnap.data() as PurchaseOrder).poNumber || '');
    const m = raw.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `PO-${max + 1}`;
}

async function nextBillNumber(tenantId: string): Promise<string> {
  const snap = await getDocs(vendorBillsCol(tenantId));
  let max = BILL_NUMBER_START;
  snap.forEach((docSnap) => {
    const raw = String((docSnap.data() as VendorBill).billNumber || '');
    const m = raw.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `BILL-${max + 1}`;
}

export function subscribeToPurchaseOrders(callback: (orders: PurchaseOrder[]) => void) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }
  const tenantId = activeTenantId;
  const q = query(purchaseOrdersCol(tenantId), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const orders: PurchaseOrder[] = [];
      snapshot.forEach((docSnap) => {
        orders.push({ id: docSnap.id, ...(docSnap.data() as Omit<PurchaseOrder, 'id'>) });
      });
      callback(orders);
    },
    (error) => {
      console.error('Error subscribing to purchase orders:', error);
      callback([]);
    }
  );
}

export function subscribeToVendorBills(callback: (bills: VendorBill[]) => void) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }
  const tenantId = activeTenantId;
  const q = query(vendorBillsCol(tenantId), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const bills: VendorBill[] = [];
      snapshot.forEach((docSnap) => {
        bills.push({ id: docSnap.id, ...(docSnap.data() as Omit<VendorBill, 'id'>) });
      });
      callback(bills);
    },
    (error) => {
      console.error('Error subscribing to vendor bills:', error);
      callback([]);
    }
  );
}

export async function createPurchaseOrder(input: {
  vendorId: string;
  vendorName: string;
  orderDate?: string;
  expectedDate?: string;
  notes?: string;
  items: Omit<PurchaseOrderLine, 'id' | 'quantityReceived'>[];
  freightCharge?: number;
  status?: PurchaseOrderStatus;
}): Promise<string> {
  const tenantId = requireTenantId();
  const id = `po-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const items: PurchaseOrderLine[] = input.items.map((item, idx) => ({
    ...item,
    id: `pol-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
    quantityReceived: 0
  }));
  const subtotal = poLineSubtotal(items);
  const freight = input.freightCharge || 0;
  const full: PurchaseOrder = {
    id,
    vendorId: input.vendorId,
    vendorName: input.vendorName,
    poNumber: await nextPoNumber(tenantId),
    status: input.status || 'draft',
    orderDate: input.orderDate || now.slice(0, 10),
    expectedDate: input.expectedDate,
    notes: input.notes,
    items,
    subtotal,
    freightCharge: freight || undefined,
    grandTotal: subtotal + freight,
    createdAt: now,
    updatedAt: now
  };
  await setDoc(purchaseOrderDoc(tenantId, id), sanitizeForFirestore(full));
  return id;
}

export async function updatePurchaseOrder(order: PurchaseOrder): Promise<void> {
  const tenantId = requireTenantId();
  const subtotal = poLineSubtotal(order.items || []);
  const freight = order.freightCharge || 0;
  const { id, ...rest } = order;
  await updateDoc(
    purchaseOrderDoc(tenantId, id),
    sanitizeForFirestore({
      ...rest,
      subtotal,
      grandTotal: subtotal + freight,
      updatedAt: new Date().toISOString()
    })
  );
}

export async function deletePurchaseOrder(orderId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(purchaseOrderDoc(tenantId, orderId));
}

export async function markPurchaseOrderSent(order: PurchaseOrder): Promise<void> {
  if (order.status === 'cancelled' || order.status === 'received') return;
  await updatePurchaseOrder({ ...order, status: 'sent' });
}

async function listInventorySnapshot(): Promise<InventoryPlant[]> {
  const tenantId = requireTenantId();
  const snap = await getDocs(collection(db, 'tenants', tenantId, 'inventory'));
  const plants: InventoryPlant[] = [];
  snap.forEach((docSnap) => {
    plants.push({ id: docSnap.id, ...(docSnap.data() as Omit<InventoryPlant, 'id'>) });
  });
  return plants;
}

/**
 * Receive quantities against a PO and add them to live inventory.
 * `receipts` maps line id → qty to receive this time (not cumulative).
 */
export async function receivePurchaseOrder(
  order: PurchaseOrder,
  receipts: Record<string, number>
): Promise<PurchaseOrder> {
  requireTenantId();
  const inventory = await listInventorySnapshot();
  const nextItems: PurchaseOrderLine[] = [];

  for (const line of order.items) {
    const addQty = Math.max(0, Math.floor(Number(receipts[line.id]) || 0));
    const remaining = Math.max(0, (line.quantityOrdered || 0) - (line.quantityReceived || 0));
    const receiveNow = Math.min(addQty, remaining);
    if (receiveNow > 0) {
      await applyReceivedQtyToInventory(inventory, {
        plantName: line.plantName,
        containerSize: line.containerSize,
        quantity: receiveNow,
        unitCost: line.unitCost,
        sourceVendorId: order.vendorId,
        sourceName: order.vendorName
      });
    }
    nextItems.push({
      ...line,
      quantityReceived: (line.quantityReceived || 0) + receiveNow
    });
  }

  const anyReceived = nextItems.some((i) => (i.quantityReceived || 0) > 0);
  let status = derivePurchaseOrderStatus(nextItems);
  if (!anyReceived) {
    status = order.status === 'sent' ? 'sent' : order.status === 'draft' ? 'draft' : order.status;
  }

  const updated: PurchaseOrder = {
    ...order,
    items: nextItems,
    status
  };

  await updatePurchaseOrder(updated);
  return updated;
}

async function applyReceivedQtyToInventory(
  inventory: InventoryPlant[],
  input: {
    plantName: string;
    containerSize: string;
    quantity: number;
    unitCost?: number;
    sourceVendorId?: string;
    sourceName?: string;
  }
) {
  const matches = findMatchingInventoryPlants(
    inventory,
    input.plantName,
    input.containerSize
  );
  const plant = matches[0];
  if (plant) {
    const updated: InventoryPlant = {
      ...plant,
      quantityAvailable: (plant.quantityAvailable || 0) + input.quantity,
      // Keep existing source; only set if this plant has none yet
      sourceVendorId: plant.sourceVendorId || input.sourceVendorId || null,
      sourceName: plant.sourceName || input.sourceName || undefined,
      dateUpdated: new Date().toISOString()
    };
    await updateInventoryPlant(updated);
    const idx = inventory.findIndex((p) => p.id === plant.id);
    if (idx >= 0) inventory[idx] = updated;
    else inventory.push(updated);
    return;
  }

  const id = await addInventoryPlant({
    plantName: input.plantName.trim(),
    containerSize: input.containerSize.trim(),
    quantityAvailable: input.quantity,
    chemicals: [],
    fertilizers: [],
    sourceVendorId: input.sourceVendorId || null,
    sourceName: input.sourceName,
    notes: input.unitCost != null ? `Received @ $${input.unitCost.toFixed(2)}` : undefined
  });
  inventory.push({
    id,
    plantName: input.plantName.trim(),
    containerSize: input.containerSize.trim(),
    quantityAvailable: input.quantity,
    chemicals: [],
    fertilizers: [],
    sourceVendorId: input.sourceVendorId || null,
    sourceName: input.sourceName,
    dateCreated: new Date().toISOString(),
    dateUpdated: new Date().toISOString()
  });
}

export async function createVendorBill(input: {
  id?: string;
  vendorId: string;
  vendorName: string;
  billDate?: string;
  dueDate?: string;
  notes?: string;
  items: Omit<VendorBillLine, 'id'>[];
  freightCharge?: number;
  purchaseOrderId?: string;
  poNumber?: string;
  vendorInvoiceNumber?: string;
  invoicePhotoUrl?: string | null;
  invoicePhotoPath?: string | null;
  status?: VendorBill['status'];
}): Promise<string> {
  const tenantId = requireTenantId();
  const id = input.id || `vbill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const items: VendorBillLine[] = input.items.map((item, idx) => ({
    ...item,
    id: `vbl-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`
  }));
  const subtotal = billLineSubtotal(items);
  const freight = input.freightCharge || 0;
  const full: VendorBill = {
    id,
    vendorId: input.vendorId,
    vendorName: input.vendorName,
    billNumber: await nextBillNumber(tenantId),
    vendorInvoiceNumber: input.vendorInvoiceNumber,
    purchaseOrderId: input.purchaseOrderId,
    poNumber: input.poNumber,
    status: input.status || 'unpaid',
    billDate: input.billDate || now.slice(0, 10),
    dueDate: input.dueDate,
    notes: input.notes,
    items,
    subtotal,
    freightCharge: freight || undefined,
    grandTotal: subtotal + freight,
    invoicePhotoUrl: input.invoicePhotoUrl ?? null,
    invoicePhotoPath: input.invoicePhotoPath ?? null,
    createdAt: now,
    updatedAt: now
  };
  await setDoc(vendorBillDoc(tenantId, id), sanitizeForFirestore(full));
  return id;
}

export async function updateVendorBill(bill: VendorBill): Promise<void> {
  const tenantId = requireTenantId();
  const subtotal = billLineSubtotal(bill.items || []);
  const freight = bill.freightCharge || 0;
  const { id, ...rest } = bill;
  const payload = sanitizeForFirestore({
    ...rest,
    id,
    subtotal,
    freightCharge: freight || undefined,
    grandTotal: subtotal + freight,
    updatedAt: new Date().toISOString()
  });
  await setDoc(vendorBillDoc(tenantId, id), payload, { merge: true });
}

export async function markVendorBillPaid(
  bill: VendorBill,
  payment?: { method: Exclude<VendorBill['paymentMethod'], 'stripe' | undefined>; reference?: string }
): Promise<void> {
  await updateVendorBill({
    ...bill,
    status: 'paid',
    paidAt: new Date().toISOString(),
    paymentMethod: payment?.method,
    paymentReference: payment?.reference?.trim() || undefined
  });
}

export async function deleteVendorBill(billId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(vendorBillDoc(tenantId, billId));
}

export async function createVendorBillFromPurchaseOrder(
  order: PurchaseOrder
): Promise<string> {
  return createVendorBill({
    vendorId: order.vendorId,
    vendorName: order.vendorName,
    purchaseOrderId: order.id,
    poNumber: order.poNumber,
    freightCharge: order.freightCharge,
    items: order.items.map((line) => ({
      plantName: line.plantName,
      containerSize: line.containerSize,
      quantity: line.quantityReceived > 0 ? line.quantityReceived : line.quantityOrdered,
      unitCost: line.unitCost,
      lineType: 'plant' as const,
      category: 'Plants',
      notes: line.notes
    }))
  });
}
