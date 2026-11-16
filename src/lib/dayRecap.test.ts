import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDayRecap, welcomeFirstName } from './dayRecap.ts';
import type { CustomerDocument, CustomerOrder, InventoryPlant, Truck, VendorBill } from '../types.ts';

const day = '2026-11-15';

function localIso(time: string, dayKey = day) {
  return new Date(`${dayKey}T${time}`).toISOString();
}

test('welcome uses the first name', () => {
  assert.equal(welcomeFirstName({ displayName: 'Alex Manger' }), 'Alex');
});

test('the morning recap is trucks today, recent payments, overdue customers, due bills, and unavailable plants', () => {
  const recap = buildDayRecap({
    dayKey: day,
    since: new Date(`${day}T00:00:00`).toISOString(),
    includeAlerts: true,
    includePayments: true,
    includeTrucks: true,
    includeOverdue: true,
    includeBills: true,
    includeInventory: true,
    orders: [
      {
        id: 'order-today',
        customerName: 'Bayou Jobs',
        orderNumber: '46340099',
        dateCreated: localIso('07:15:00'),
        items: []
      },
      {
        id: 'order-old',
        customerName: 'Last Week',
        orderNumber: '1',
        dateCreated: new Date('2026-11-10T12:00:00').toISOString(),
        items: [{ id: 'line-1', plantName: 'Holly', containerSize: '#3', addedAt: localIso('09:00:00') }]
      }
    ] as CustomerOrder[],
    documents: [
      {
        id: 'paid-recent',
        type: 'invoice',
        paymentStatus: 'paid',
        paidAt: localIso('08:00:00', '2026-11-12'),
        documentNumber: '1004',
        customerName: 'Dirt Road',
        grandTotal: 23,
        stripePaidAmountCents: 2300
      },
      {
        id: 'paid-old',
        type: 'invoice',
        paymentStatus: 'paid',
        paidAt: localIso('08:00:00', '2026-11-01'),
        documentNumber: '1001',
        customerName: 'Older',
        grandTotal: 10
      },
      {
        id: 'overdue-a',
        type: 'invoice',
        paymentStatus: 'unpaid',
        dueDate: '2026-11-01',
        documentNumber: '900',
        customerName: 'Late Co',
        grandTotal: 40
      },
      {
        id: 'overdue-b',
        type: 'invoice',
        paymentStatus: 'unpaid',
        dueDate: '2026-11-10',
        documentNumber: '901',
        customerName: 'Late Co',
        grandTotal: 15
      },
      {
        id: 'current',
        type: 'invoice',
        paymentStatus: 'unpaid',
        dueDate: '2026-11-20',
        documentNumber: '902',
        customerName: 'Not Yet',
        grandTotal: 80
      }
    ] as CustomerDocument[],
    trucks: [
      {
        id: 'truck-today',
        name: 'Lafayette',
        status: 'loading',
        loadingDate: day,
        dateCreated: '2026-11-01T12:00:00.000Z',
        orderIds: ['a', 'b']
      },
      {
        id: 'truck-tomorrow',
        name: 'Tomorrow',
        status: 'pending',
        loadingDate: '2026-11-22',
        dateCreated: '2026-11-01T12:00:00.000Z',
        orderIds: []
      }
    ] as Truck[],
    bills: [
      {
        id: 'due-soon',
        vendorName: 'Stroud',
        billNumber: 'BILL-2',
        status: 'unpaid',
        dueDate: '2026-11-18',
        grandTotal: 50
      },
      {
        id: 'overdue-bill',
        vendorName: 'Grower',
        billNumber: 'BILL-1',
        status: 'unpaid',
        dueDate: '2026-11-10',
        grandTotal: 12
      },
      {
        id: 'later',
        vendorName: 'Later',
        billNumber: 'BILL-9',
        status: 'unpaid',
        dueDate: '2026-12-20',
        grandTotal: 99
      },
      {
        id: 'old-overdue',
        vendorName: 'Old',
        billNumber: 'BILL-OLD',
        status: 'unpaid',
        dueDate: '2026-10-01',
        grandTotal: 8
      }
    ] as VendorBill[],
    plants: [
      {
        id: 'off',
        plantName: 'Holly',
        containerSize: '#7',
        quantityAvailable: 0,
        notAvailable: true,
        dateCreated: '2026-10-01T12:00:00.000Z',
        dateUpdated: localIso('11:00:00')
      },
      {
        id: 'on',
        plantName: 'Azalea',
        containerSize: '#1',
        quantityAvailable: 4,
        notAvailable: false,
        dateCreated: '2026-10-01T12:00:00.000Z',
        dateUpdated: localIso('11:00:00')
      },
      {
        id: 'empty-but-available',
        plantName: 'Boxwood',
        containerSize: '#3',
        quantityAvailable: 0,
        notAvailable: false,
        dateCreated: '2026-10-01T12:00:00.000Z',
        dateUpdated: localIso('11:00:00')
      }
    ] as InventoryPlant[]
  });

  assert.deepEqual(
    recap.alerts.map((row) => row.kind),
    ['plant', 'order']
  );
  assert.deepEqual(
    recap.payments.map((row) => row.documentNumber),
    ['1004']
  );
  assert.deepEqual(
    recap.trucks.map((row) => row.name),
    ['Lafayette']
  );
  assert.deepEqual(
    recap.overdue.map((row) => row.documentNumber),
    ['900', '901']
  );
  assert.equal(recap.overdue[0].customerName, 'Late Co');
  assert.equal(recap.overdue[0].amount, 40);
  assert.deepEqual(
    recap.bills.map((row) => row.billNumber),
    ['BILL-OLD', 'BILL-1']
  );
  assert.equal(recap.bills[0].overdue, true);
  assert.deepEqual(
    recap.unavailable.map((row) => row.plantName),
    ['Holly']
  );
});
