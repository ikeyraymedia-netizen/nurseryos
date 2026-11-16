import { startOfWeekSunday, weekDateKeysFromSunday } from './dates';
import { invoiceBalanceDue } from './documents';
import { billBalanceDue } from './manualPayment';
import type { CustomerDocument, CustomerOrder, InventoryPlant, Truck, VendorBill } from '../types';

const RECENT_PAYMENT_DAYS = 7;

export interface DayRecapPayment {
  id: string;
  documentNumber: string;
  customerName: string;
  amount: number;
  paidAt: string;
}

export interface DayRecapTruck {
  id: string;
  name: string;
  status: Truck['status'];
  orderCount: number;
  loadingDate: string;
}

export type DayRecapAlertKind = 'order' | 'plant' | 'truck' | 'inventory';

export interface DayRecapAlert {
  id: string;
  kind: DayRecapAlertKind;
  title: string;
  detail: string;
  at: string;
}

export interface DayRecapOverdue {
  id: string;
  documentNumber: string;
  customerName: string;
  amount: number;
  due: string;
}

export interface DayRecapBill {
  id: string;
  vendorName: string;
  billNumber: string;
  amount: number;
  due: string;
  overdue: boolean;
}

export interface DayRecapUnavailable {
  id: string;
  plantName: string;
  containerSize: string;
}

export interface DayRecap {
  alerts: DayRecapAlert[];
  payments: DayRecapPayment[];
  trucks: DayRecapTruck[];
  showTrucks: boolean;
  overdue: DayRecapOverdue[];
  bills: DayRecapBill[];
  unavailable: DayRecapUnavailable[];
}

export function localDayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  return localDayKey(date);
}

export function dayKeyOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const value = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return localDayKey(date);
}

export function isoOnLocalDay(iso: string | null | undefined, dayKey: string): boolean {
  return dayKeyOf(iso) === dayKey;
}

export function welcomeFirstName(person: {
  displayName?: string | null;
  email?: string | null;
}): string {
  const name = person.displayName?.trim();
  if (name) return name.split(/\s+/)[0] || '';
  const local = person.email?.trim().split('@')[0] || '';
  return local.split(/[._-]/)[0] || '';
}

function welcomeSeenKey(tenantId: string, userId: string) {
  return `nurseryos:welcomeBackDay:${tenantId}:${userId}`;
}

export function getWelcomeSeenDay(tenantId: string, userId: string): string | null {
  try {
    return localStorage.getItem(welcomeSeenKey(tenantId, userId));
  } catch {
    return null;
  }
}

export function setWelcomeSeenDay(tenantId: string, userId: string, dayKey: string) {
  try {
    localStorage.setItem(welcomeSeenKey(tenantId, userId), dayKey);
  } catch {
    // ignore quota / private mode
  }
}

export function dayRecapIsEmpty(recap: DayRecap): boolean {
  return (
    recap.alerts.length === 0 &&
    recap.payments.length === 0 &&
    recap.trucks.length === 0 &&
    recap.overdue.length === 0 &&
    recap.bills.length === 0 &&
    recap.unavailable.length === 0
  );
}

const ALERT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function alertSince(since: string | null | undefined, dayKey: string): string {
  const floor = new Date(Date.now() - ALERT_LOOKBACK_MS).toISOString();
  const startToday = new Date(`${dayKey}T00:00:00`).toISOString();
  const baseline = since && since > floor ? since : since ? floor : startToday;
  return baseline;
}

export function buildDayRecap(params: {
  dayKey: string;
  since?: string | null;
  orders: CustomerOrder[];
  trucks: Truck[];
  documents: CustomerDocument[];
  plants: InventoryPlant[];
  bills: VendorBill[];
  includeAlerts: boolean;
  includePayments: boolean;
  includeTrucks: boolean;
  includeOverdue: boolean;
  includeBills: boolean;
  includeInventory: boolean;
}): DayRecap {
  const since = alertSince(params.since, params.dayKey);
  const alerts: DayRecapAlert[] = [];
  if (params.includeAlerts) {
    for (const order of params.orders) {
      const created = order.dateCreated || '';
      if (created > since) {
        alerts.push({
          id: `order-${order.id}`,
          kind: 'order',
          title: order.customerName || 'Customer',
          detail: order.orderNumber || '',
          at: created
        });
        continue;
      }
      for (const line of order.items || []) {
        if (!line.addedAt || line.addedAt <= since) continue;
        alerts.push({
          id: `plant-${order.id}-${line.id}`,
          kind: 'plant',
          title: line.plantName || 'Plant',
          detail: [line.containerSize, order.customerName].filter(Boolean).join(' · '),
          at: line.addedAt
        });
      }
    }
    for (const truck of params.trucks) {
      if (!truck.dateCreated || truck.dateCreated <= since) continue;
      alerts.push({
        id: `truck-${truck.id}`,
        kind: 'truck',
        title: truck.name || 'Truck',
        detail: truck.loadingDate || '',
        at: truck.dateCreated
      });
    }
    for (const plant of params.plants) {
      if (!plant.dateCreated || plant.dateCreated <= since) continue;
      alerts.push({
        id: `inventory-${plant.id}`,
        kind: 'inventory',
        title: plant.plantName || 'Plant',
        detail: plant.containerSize || '',
        at: plant.dateCreated
      });
    }
    alerts.sort((a, b) => b.at.localeCompare(a.at));
  }

  const weekDays = new Set(
    weekDateKeysFromSunday(
      startOfWeekSunday(
        new Date(
          Number(params.dayKey.slice(0, 4)),
          Number(params.dayKey.slice(5, 7)) - 1,
          Number(params.dayKey.slice(8, 10))
        )
      )
    )
  );
  const recentFloor = shiftDayKey(params.dayKey, -(RECENT_PAYMENT_DAYS - 1));

  const payments: DayRecapPayment[] = [];
  if (params.includePayments) {
    for (const doc of params.documents) {
      if (doc.type !== 'invoice' || doc.paymentStatus !== 'paid' || !doc.paidAt) continue;
      const paidDay = dayKeyOf(doc.paidAt);
      if (!paidDay || paidDay < recentFloor || paidDay > params.dayKey) continue;
      const amount =
        typeof doc.stripePaidAmountCents === 'number'
          ? doc.stripePaidAmountCents / 100
          : Number(doc.grandTotal) || 0;
      payments.push({
        id: doc.id,
        documentNumber: doc.documentNumber || 'Invoice',
        customerName: doc.billToName || doc.customerName || 'Customer',
        amount,
        paidAt: doc.paidAt
      });
    }
    payments.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  }

  const trucks: DayRecapTruck[] = [];
  if (params.includeTrucks) {
    for (const truck of params.trucks) {
      const day = (truck.loadingDate || '').trim().slice(0, 10);
      if (!weekDays.has(day)) continue;
      trucks.push({
        id: truck.id,
        name: truck.name || 'Truck',
        status: truck.status,
        orderCount: truck.orderIds.length,
        loadingDate: day
      });
    }
    trucks.sort((a, b) => a.loadingDate.localeCompare(b.loadingDate) || a.name.localeCompare(b.name));
  }

  const overdue: DayRecapOverdue[] = [];
  if (params.includeOverdue) {
    for (const doc of params.documents) {
      if (doc.type !== 'invoice') continue;
      const balance = invoiceBalanceDue(doc);
      if (balance <= 0.009) continue;
      const due = dayKeyOf(doc.dueDate) || dayKeyOf(doc.documentDate);
      if (!due || due >= params.dayKey) continue;
      overdue.push({
        id: doc.id,
        documentNumber: doc.documentNumber || 'Invoice',
        customerName: doc.customerName || doc.billToName || 'Customer',
        amount: balance,
        due
      });
    }
    overdue.sort((a, b) => a.due.localeCompare(b.due) || b.amount - a.amount);
  }

  const bills: DayRecapBill[] = [];
  if (params.includeBills) {
    for (const bill of params.bills) {
      const balance = billBalanceDue(bill);
      if (balance <= 0.009 || bill.status === 'paid') continue;
      const due = dayKeyOf(bill.dueDate);
      if (!due || due >= params.dayKey) continue;
      bills.push({
        id: bill.id,
        vendorName: bill.vendorName || 'Vendor',
        billNumber: bill.vendorInvoiceNumber || bill.billNumber || 'Bill',
        amount: balance,
        due,
        overdue: due < params.dayKey
      });
    }
    bills.sort((a, b) => a.due.localeCompare(b.due));
  }

  const unavailable: DayRecapUnavailable[] = [];
  if (params.includeInventory) {
    for (const plant of params.plants) {
      if (!plant.notAvailable) continue;
      unavailable.push({
        id: plant.id,
        plantName: plant.plantName || 'Plant',
        containerSize: plant.containerSize || ''
      });
    }
    unavailable.sort((a, b) => a.plantName.localeCompare(b.plantName));
  }

  return {
    alerts,
    payments,
    trucks,
    showTrucks: params.includeTrucks,
    overdue,
    bills,
    unavailable
  };
}
