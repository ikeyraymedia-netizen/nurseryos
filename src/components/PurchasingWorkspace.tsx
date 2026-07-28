import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  ClipboardList,
  FileText,
  Mail,
  PackagePlus,
  Plus,
  Receipt,
  ScanLine,
  Search,
  Trash2,
  X
} from 'lucide-react';
import {
  PurchaseOrder,
  PurchaseOrderLine,
  Vendor,
  VendorBill
} from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  addVendor,
  deleteVendor,
  subscribeToVendors,
  updateVendor
} from '../lib/vendors';
import {
  createPurchaseOrder,
  createVendorBill,
  createVendorBillFromPurchaseOrder,
  deletePurchaseOrder,
  deleteVendorBill,
  markPurchaseOrderSent,
  markVendorBillPaid,
  receivePurchaseOrder,
  subscribeToPurchaseOrders,
  subscribeToVendorBills
} from '../lib/purchasing';
import {
  emptyBillLine,
  isPlantPurchaseCategory,
  resolvePurchaseCategory,
  purchaseCategoryLabel
} from '../lib/purchaseCategories';
import { sendTenantEmail } from '../lib/email';
import {
  buildPurchaseOrderEmailHtml,
  buildPurchaseOrderEmailText,
  defaultPurchaseOrderEmailSubject
} from '../lib/purchaseOrderEmail';
import { VendorInvoiceScanner } from './VendorInvoiceScanner';
import { PurchaseCategoryField } from './PurchaseCategoryField';
import { CREATE_NEW_VENDOR, VendorPicker } from './VendorPicker';

type PurchasingView = 'vendors' | 'orders' | 'bills';

interface PurchasingWorkspaceProps {
  permissions: AppPermissions;
  tenantId: string;
  nurseryName: string;
}

function money(n: number) {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyLine(): Omit<PurchaseOrderLine, 'id' | 'quantityReceived'> {
  return {
    plantName: '',
    containerSize: '',
    quantityOrdered: 1,
    unitCost: 0
  };
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-700',
    sent: 'bg-sky-100 text-sky-800',
    partial: 'bg-amber-100 text-amber-800',
    received: 'bg-emerald-100 text-emerald-800',
    cancelled: 'bg-rose-100 text-rose-800',
    unpaid: 'bg-amber-100 text-amber-800',
    paid: 'bg-emerald-700 text-white'
  };
  return map[status] || 'bg-slate-100 text-slate-700';
}

export function PurchasingWorkspace({
  permissions,
  tenantId,
  nurseryName
}: PurchasingWorkspaceProps) {
  const [view, setView] = useState<PurchasingView>('orders');
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [bills, setBills] = useState<VendorBill[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInvoiceScanner, setShowInvoiceScanner] = useState(false);

  // Email PO
  const [emailingOrder, setEmailingOrder] = useState<PurchaseOrder | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);

  // Vendor form
  const [vendorName, setVendorName] = useState('');
  const [vendorEmail, setVendorEmail] = useState('');
  const [vendorPhone, setVendorPhone] = useState('');
  const [vendorContact, setVendorContact] = useState('');
  const [vendorTerms, setVendorTerms] = useState('');
  const [editingVendorId, setEditingVendorId] = useState<string | null>(null);

  // PO form
  const [showPoForm, setShowPoForm] = useState(false);
  const [poVendorId, setPoVendorId] = useState('');
  const [poExpected, setPoExpected] = useState('');
  const [poNotes, setPoNotes] = useState('');
  const [poLines, setPoLines] = useState([emptyLine()]);

  // Receive
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [receiptQty, setReceiptQty] = useState<Record<string, number>>({});

  // Bill form
  const [showBillForm, setShowBillForm] = useState(false);
  const [billVendorId, setBillVendorId] = useState('');
  const [billNewVendorName, setBillNewVendorName] = useState('');
  const [billDue, setBillDue] = useState('');
  const [billNotes, setBillNotes] = useState('');
  const [billLines, setBillLines] = useState([emptyBillLine()]);

  useEffect(() => {
    const unsubV = subscribeToVendors(setVendors);
    const unsubO = subscribeToPurchaseOrders(setOrders);
    const unsubB = subscribeToVendorBills(setBills);
    return () => {
      unsubV();
      unsubO();
      unsubB();
    };
  }, []);

  const q = search.toLowerCase().trim();

  const filteredVendors = useMemo(() => {
    if (!q) return vendors;
    return vendors.filter((v) =>
      [v.name, v.contactEmail, v.phone, v.contactName].join(' ').toLowerCase().includes(q)
    );
  }, [vendors, q]);

  const filteredOrders = useMemo(() => {
    if (!q) return orders;
    return orders.filter((o) =>
      [o.poNumber, o.vendorName, o.status, o.notes].join(' ').toLowerCase().includes(q)
    );
  }, [orders, q]);

  const filteredBills = useMemo(() => {
    if (!q) return bills;
    return bills.filter((b) =>
      [b.billNumber, b.vendorName, b.status, b.poNumber].join(' ').toLowerCase().includes(q)
    );
  }, [bills, q]);

  const billTotals = useMemo(() => {
    let outstanding = 0;
    let overdue = 0;
    const today = todayKey();
    for (const bill of bills) {
      if (bill.status === 'paid') continue;
      outstanding += bill.grandTotal || 0;
      if (bill.dueDate && bill.dueDate < today) overdue += bill.grandTotal || 0;
    }
    return { outstanding, overdue, count: bills.length };
  }, [bills]);

  const monthKey = todayKey().slice(0, 7);

  const monthPurchases = useMemo(() => {
    const monthBills = bills.filter((b) => (b.billDate || '').startsWith(monthKey));
    const byCategory = new Map<string, number>();
    const byVendor = new Map<string, number>();
    let total = 0;

    for (const bill of monthBills) {
      total += bill.grandTotal || 0;
      byVendor.set(bill.vendorName, (byVendor.get(bill.vendorName) || 0) + (bill.grandTotal || 0));
      for (const line of bill.items || []) {
        const cat = purchaseCategoryLabel(
          line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
        );
        const amount = (line.quantity || 0) * (line.unitCost || 0);
        byCategory.set(cat, (byCategory.get(cat) || 0) + amount);
      }
      // Legacy header freight on older bills (not stored as a line)
      if (bill.freightCharge) {
        const label = 'Freight';
        byCategory.set(label, (byCategory.get(label) || 0) + bill.freightCharge);
      }
    }

    const categories = [...byCategory.entries()]
      .map(([id, amount]) => ({ id, label: id, amount }))
      .sort((a, b) => b.amount - a.amount);
    const vendorsTop = [...byVendor.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    return {
      billCount: monthBills.length,
      total,
      categories,
      vendorsTop
    };
  }, [bills, monthKey]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function resetVendorForm() {
    setVendorName('');
    setVendorEmail('');
    setVendorPhone('');
    setVendorContact('');
    setVendorTerms('');
    setEditingVendorId(null);
  }

  async function handleSaveVendor(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canEditVendors) return;
    const name = vendorName.trim();
    if (!name) return;
    await run(async () => {
      if (editingVendorId) {
        const existing = vendors.find((v) => v.id === editingVendorId);
        if (!existing) return;
        await updateVendor({
          ...existing,
          name,
          contactEmail: vendorEmail.trim() || undefined,
          phone: vendorPhone.trim() || undefined,
          contactName: vendorContact.trim() || undefined,
          paymentTerms: vendorTerms.trim() || undefined
        });
      } else {
        await addVendor({
          name,
          contactEmail: vendorEmail.trim() || undefined,
          phone: vendorPhone.trim() || undefined,
          contactName: vendorContact.trim() || undefined,
          paymentTerms: vendorTerms.trim() || undefined
        });
      }
      resetVendorForm();
    });
  }

  async function handleCreatePo(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canEditPurchaseOrders) return;
    const vendor = vendors.find((v) => v.id === poVendorId);
    if (!vendor) {
      setError('Pick a vendor.');
      return;
    }
    const items = poLines
      .map((l) => ({
        plantName: l.plantName.trim(),
        containerSize: l.containerSize.trim(),
        quantityOrdered: Math.max(0, Number(l.quantityOrdered) || 0),
        unitCost: Math.max(0, Number(l.unitCost) || 0),
        notes: l.notes
      }))
      .filter((l) => l.plantName && l.quantityOrdered > 0);
    if (items.length === 0) {
      setError('Add at least one plant line.');
      return;
    }
    await run(async () => {
      await createPurchaseOrder({
        vendorId: vendor.id,
        vendorName: vendor.name,
        expectedDate: poExpected || undefined,
        notes: poNotes.trim() || undefined,
        items,
        status: 'draft'
      });
      setShowPoForm(false);
      setPoVendorId('');
      setPoExpected('');
      setPoNotes('');
      setPoLines([emptyLine()]);
    });
  }

  function openReceive(order: PurchaseOrder) {
    const initial: Record<string, number> = {};
    for (const line of order.items) {
      const remaining = Math.max(0, line.quantityOrdered - (line.quantityReceived || 0));
      initial[line.id] = remaining;
    }
    setReceiptQty(initial);
    setReceivingOrder(order);
  }

  function openEmailPo(order: PurchaseOrder) {
    const vendor = vendors.find((v) => v.id === order.vendorId);
    setEmailingOrder(order);
    setEmailTo(vendor?.contactEmail || '');
    setEmailSubject(defaultPurchaseOrderEmailSubject(nurseryName, order));
    setEmailMessage('');
    setEmailStatus(null);
  }

  async function handleSendPoEmail(e: FormEvent) {
    e.preventDefault();
    if (!emailingOrder || !permissions.canEditPurchaseOrders) return;
    const to = emailTo.trim();
    if (!to || !to.includes('@')) {
      setEmailStatus('Enter a valid vendor email.');
      return;
    }
    setEmailSending(true);
    setEmailStatus(null);
    try {
      const result = await sendTenantEmail({
        tenantId,
        to,
        subject: emailSubject.trim() || defaultPurchaseOrderEmailSubject(nurseryName, emailingOrder),
        text: buildPurchaseOrderEmailText({
          nurseryName,
          order: emailingOrder,
          message: emailMessage
        }),
        html: buildPurchaseOrderEmailHtml({
          nurseryName,
          order: emailingOrder,
          message: emailMessage
        }),
        fromName: nurseryName
      });
      if (!result.success) {
        throw new Error(
          result.message ||
            result.error ||
            'Email is not configured. Open Team → Outbound email, and set RESEND_API_KEY in Railway.'
        );
      }

      // Remember vendor email if they typed a new one
      const vendor = vendors.find((v) => v.id === emailingOrder.vendorId);
      if (vendor && permissions.canEditVendors && to !== (vendor.contactEmail || '')) {
        await updateVendor({ ...vendor, contactEmail: to });
      }

      if (emailingOrder.status === 'draft') {
        await markPurchaseOrderSent(emailingOrder);
      }

      setEmailStatus(`Sent to ${to}`);
      window.setTimeout(() => {
        setEmailingOrder(null);
        setEmailStatus(null);
      }, 1200);
    } catch (err: unknown) {
      setEmailStatus(err instanceof Error ? err.message : 'Could not send email.');
    } finally {
      setEmailSending(false);
    }
  }

  async function handleReceive() {
    if (!receivingOrder || !permissions.canReceivePurchases) return;
    await run(async () => {
      await receivePurchaseOrder(receivingOrder, receiptQty);
      setReceivingOrder(null);
      setReceiptQty({});
    });
  }

  async function handleCreateBill(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canManageVendorBills) return;

    let vendor = vendors.find((v) => v.id === billVendorId) || null;
    if (billVendorId === CREATE_NEW_VENDOR) {
      const name = billNewVendorName.trim();
      if (!name) {
        setError('Enter a vendor name.');
        return;
      }
      if (!permissions.canEditVendors) {
        setError('You need permission to create vendors.');
        return;
      }
    } else if (!vendor) {
      setError('Pick a saved vendor, or create a new one.');
      return;
    }

    const items = billLines
      .map((l) => ({
        plantName: l.plantName.trim(),
        containerSize: isPlantPurchaseCategory(l.category)
          ? l.containerSize.trim() || 'Other'
          : l.containerSize.trim(),
        quantity: Math.max(0, Number(l.quantity) || 0),
        unitCost: Math.max(0, Number(l.unitCost) || 0),
        category: resolvePurchaseCategory(l.category)
      }))
      .filter((l) => l.plantName && l.quantity > 0);
    if (items.length === 0) {
      setError('Add at least one line.');
      return;
    }
    await run(async () => {
      if (billVendorId === CREATE_NEW_VENDOR) {
        const name = billNewVendorName.trim();
        const id = await addVendor({ name });
        vendor = {
          id,
          name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      if (!vendor) return;
      await createVendorBill({
        vendorId: vendor.id,
        vendorName: vendor.name,
        dueDate: billDue || undefined,
        notes: billNotes.trim() || undefined,
        items
      });
      setShowBillForm(false);
      setBillVendorId('');
      setBillNewVendorName('');
      setBillDue('');
      setBillNotes('');
      setBillLines([emptyBillLine()]);
    });
  }

  return (
    <div className="bg-white rounded-2xl border border-ink-100 p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-ink-50 flex items-center justify-center">
            <PackagePlus className="h-5 w-5 text-ink-700" />
          </div>
          <div>
            <h2 className="text-base font-black text-slate-900 tracking-tight">Purchasing</h2>
            <p className="text-xs text-slate-500">
              Upload all nursery purchases here — plants, supplies, freight, and bills
            </p>
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-ink-200 overflow-hidden">
          {(
            [
              ['orders', 'POs', ClipboardList],
              ['vendors', 'Vendors', Building2],
              ['bills', 'Bills', Receipt]
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
                view === id
                  ? 'bg-ink-700 text-white'
                  : 'bg-white text-ink-800 hover:bg-ink-50'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            view === 'vendors'
              ? 'Search vendors…'
              : view === 'orders'
                ? 'Search purchase orders…'
                : 'Search vendor bills…'
          }
          className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
        />
      </div>

      {error && (
        <p className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {view === 'bills' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-bold uppercase text-slate-500">Bills</p>
              <p className="text-sm font-black text-slate-900">{billTotals.count}</p>
            </div>
            <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2">
              <p className="text-[10px] font-bold uppercase text-amber-700">Outstanding</p>
              <p className="text-sm font-black text-amber-900">{money(billTotals.outstanding)}</p>
            </div>
            <div className="rounded-xl border border-rose-100 bg-rose-50/60 px-3 py-2">
              <p className="text-[10px] font-bold uppercase text-rose-700">Overdue</p>
              <p className="text-sm font-black text-rose-900">{money(billTotals.overdue)}</p>
            </div>
          </div>

          <div className="rounded-xl border border-ink-100 bg-ink-50/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-900">
                Purchases this month
              </p>
              <p className="text-sm font-black text-ink-900">{money(monthPurchases.total)}</p>
            </div>
            <p className="text-[11px] text-slate-500">
              {monthPurchases.billCount} bill{monthPurchases.billCount === 1 ? '' : 's'}
            </p>
            {monthPurchases.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {monthPurchases.categories.map((row) => (
                  <span
                    key={row.id}
                    className="text-[10px] font-bold px-2 py-1 rounded-full bg-white border border-ink-100 text-ink-800"
                  >
                    {row.label} {money(row.amount)}
                  </span>
                ))}
              </div>
            )}
            {monthPurchases.vendorsTop.length > 0 && (
              <div className="text-[11px] text-slate-600 space-y-0.5">
                {monthPurchases.vendorsTop.map((v) => (
                  <div key={v.name} className="flex justify-between gap-2">
                    <span className="truncate">{v.name}</span>
                    <span className="font-bold text-slate-800 shrink-0">{money(v.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {monthPurchases.billCount === 0 && (
              <p className="text-[11px] text-slate-500">
                No purchases logged this month yet — scan an invoice to start.
              </p>
            )}
          </div>
        </div>
      )}

      {view === 'vendors' && permissions.canManageVendorBills && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowInvoiceScanner((o) => !o)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold"
            >
              <ScanLine className="h-3.5 w-3.5" />
              {showInvoiceScanner ? 'Hide invoice scan' : 'Scan vendor invoice'}
            </button>
          </div>
          {showInvoiceScanner && (
            <VendorInvoiceScanner
              tenantId={tenantId}
              vendors={vendors}
              permissions={permissions}
              onSaved={() => {
                setShowInvoiceScanner(false);
                setView('bills');
              }}
            />
          )}
        </div>
      )}

      {view === 'vendors' && (
        <div className="grid lg:grid-cols-5 gap-4">
          {permissions.canEditVendors && (
            <form
              onSubmit={handleSaveVendor}
              className="lg:col-span-2 rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-2"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-ink-900">
                {editingVendorId ? 'Edit vendor' : 'Add vendor'}
              </p>
              <input
                required
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="Vendor name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <input
                value={vendorContact}
                onChange={(e) => setVendorContact(e.target.value)}
                placeholder="Contact name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <input
                value={vendorEmail}
                onChange={(e) => setVendorEmail(e.target.value)}
                placeholder="Email"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <input
                value={vendorPhone}
                onChange={(e) => setVendorPhone(e.target.value)}
                placeholder="Phone"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <input
                value={vendorTerms}
                onChange={(e) => setVendorTerms(e.target.value)}
                placeholder="Payment terms"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
                >
                  {editingVendorId ? 'Save' : 'Add vendor'}
                </button>
                {editingVendorId && (
                  <button
                    type="button"
                    onClick={resetVendorForm}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-600"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
          <div className={`${permissions.canEditVendors ? 'lg:col-span-3' : 'lg:col-span-5'} space-y-2 max-h-[520px] overflow-y-auto`}>
            {filteredVendors.length === 0 ? (
              <p className="text-xs text-gray-500 py-8 text-center">No vendors yet.</p>
            ) : (
              filteredVendors.map((v) => (
                <div
                  key={v.id}
                  className="border border-gray-100 rounded-xl p-3 hover:border-ink-200 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-gray-900">{v.name}</p>
                      <p className="text-xs text-gray-500">
                        {[v.contactName, v.contactEmail, v.phone].filter(Boolean).join(' · ') ||
                          'No contact info'}
                      </p>
                      {v.paymentTerms && (
                        <p className="text-[11px] text-ink-700 mt-1">Terms: {v.paymentTerms}</p>
                      )}
                    </div>
                    {permissions.canEditVendors && (
                      <div className="flex gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingVendorId(v.id);
                            setVendorName(v.name);
                            setVendorEmail(v.contactEmail || '');
                            setVendorPhone(v.phone || '');
                            setVendorContact(v.contactName || '');
                            setVendorTerms(v.paymentTerms || '');
                          }}
                          className="text-[10px] font-bold text-ink-700 px-2 py-1 rounded-lg hover:bg-ink-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void run(async () => {
                              if (!confirm(`Delete vendor “${v.name}”?`)) return;
                              await deleteVendor(v.id);
                            })
                          }
                          className="text-[10px] font-bold text-rose-700 px-2 py-1 rounded-lg hover:bg-rose-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {view === 'orders' && (
        <div className="space-y-3">
          {permissions.canEditPurchaseOrders && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowPoForm((o) => !o)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold"
              >
                <Plus className="h-3.5 w-3.5" />
                New purchase order
              </button>
            </div>
          )}

          {showPoForm && permissions.canEditPurchaseOrders && (
            <form
              onSubmit={handleCreatePo}
              className="rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-3"
            >
              <div className="grid sm:grid-cols-2 gap-2">
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">Vendor</span>
                  <select
                    required
                    value={poVendorId}
                    onChange={(e) => setPoVendorId(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  >
                    <option value="">Select…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">Expected</span>
                  <input
                    type="date"
                    value={poExpected}
                    onChange={(e) => setPoExpected(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                </label>
              </div>
              <div className="space-y-2">
                {poLines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-1.5">
                    <input
                      value={line.plantName}
                      onChange={(e) => {
                        const next = [...poLines];
                        next[idx] = { ...line, plantName: e.target.value };
                        setPoLines(next);
                      }}
                      placeholder="Plant"
                      className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    <input
                      value={line.containerSize}
                      onChange={(e) => {
                        const next = [...poLines];
                        next[idx] = { ...line, containerSize: e.target.value };
                        setPoLines(next);
                      }}
                      placeholder="Size"
                      className="col-span-2 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    <input
                      type="number"
                      min={1}
                      value={line.quantityOrdered}
                      onChange={(e) => {
                        const next = [...poLines];
                        next[idx] = { ...line, quantityOrdered: Number(e.target.value) || 0 };
                        setPoLines(next);
                      }}
                      placeholder="Qty"
                      className="col-span-2 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitCost}
                      onChange={(e) => {
                        const next = [...poLines];
                        next[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                        setPoLines(next);
                      }}
                      placeholder="Cost"
                      className="col-span-3 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setPoLines(poLines.filter((_, i) => i !== idx))}
                      className="col-span-1 text-rose-600 flex items-center justify-center"
                      disabled={poLines.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setPoLines([...poLines, emptyLine()])}
                  className="text-[11px] font-bold text-ink-700"
                >
                  + Add line
                </button>
              </div>
              <textarea
                value={poNotes}
                onChange={(e) => setPoNotes(e.target.value)}
                placeholder="Notes"
                rows={2}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={busy || vendors.length === 0}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                Create PO
              </button>
              {vendors.length === 0 && (
                <p className="text-[11px] text-amber-700">Add a vendor first.</p>
              )}
            </form>
          )}

          <div className="space-y-2 max-h-[520px] overflow-y-auto">
            {filteredOrders.length === 0 ? (
              <p className="text-xs text-gray-500 py-8 text-center">No purchase orders yet.</p>
            ) : (
              filteredOrders.map((order) => (
                <div
                  key={order.id}
                  className="border border-gray-100 rounded-xl p-3 hover:border-ink-200 transition space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-gray-900">
                        {order.poNumber}
                        <span className="font-semibold text-gray-500"> · {order.vendorName}</span>
                      </p>
                      <p className="text-xs text-gray-500">
                        {order.orderDate}
                        {order.expectedDate ? ` · Due ${order.expectedDate}` : ''} ·{' '}
                        {money(order.grandTotal)} · {order.items.length} line
                        {order.items.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${statusBadge(order.status)}`}
                    >
                      {order.status}
                    </span>
                  </div>
                  <ul className="text-[11px] text-slate-600 space-y-0.5">
                    {order.items.slice(0, 4).map((line) => (
                      <li key={line.id}>
                        {line.plantName} {line.containerSize} — {line.quantityReceived}/
                        {line.quantityOrdered} @ {money(line.unitCost)}
                      </li>
                    ))}
                    {order.items.length > 4 && (
                      <li className="text-slate-400">+{order.items.length - 4} more</li>
                    )}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    {permissions.canEditPurchaseOrders &&
                      order.status !== 'cancelled' &&
                      order.status !== 'received' && (
                        <button
                          type="button"
                          disabled={busy || emailSending}
                          onClick={() => openEmailPo(order)}
                          className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-ink-700 text-white"
                        >
                          <Mail className="h-3 w-3" />
                          Email vendor
                        </button>
                      )}
                    {permissions.canEditPurchaseOrders && order.status === 'draft' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => markPurchaseOrderSent(order))}
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-700 text-white"
                      >
                        Mark sent
                      </button>
                    )}
                    {permissions.canReceivePurchases &&
                      order.status !== 'cancelled' &&
                      order.status !== 'received' && (
                        <button
                          type="button"
                          onClick={() => openReceive(order)}
                          className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-ink-700 text-white"
                        >
                          Receive
                        </button>
                      )}
                    {permissions.canManageVendorBills && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await createVendorBillFromPurchaseOrder(order);
                            setView('bills');
                          })
                        }
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg border border-ink-200 text-ink-800"
                      >
                        Create bill
                      </button>
                    )}
                    {permissions.canEditPurchaseOrders && order.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            if (!confirm(`Delete ${order.poNumber}?`)) return;
                            await deletePurchaseOrder(order.id);
                          })
                        }
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg text-rose-700"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {view === 'bills' && (
        <div className="space-y-3">
          {permissions.canManageVendorBills && (
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowInvoiceScanner((o) => !o);
                  setShowBillForm(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-ink-200 bg-white text-ink-800 text-xs font-bold"
              >
                <ScanLine className="h-3.5 w-3.5" />
                {showInvoiceScanner ? 'Hide scan' : 'Scan invoice'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowBillForm((o) => !o);
                  setShowInvoiceScanner(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold"
              >
                <Plus className="h-3.5 w-3.5" />
                New vendor bill
              </button>
            </div>
          )}

          {showInvoiceScanner && permissions.canManageVendorBills && (
            <VendorInvoiceScanner
              tenantId={tenantId}
              vendors={vendors}
              permissions={permissions}
              onSaved={() => setShowInvoiceScanner(false)}
            />
          )}

          {showBillForm && permissions.canManageVendorBills && (
            <form
              onSubmit={handleCreateBill}
              className="rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-3"
            >
              <div className="grid sm:grid-cols-2 gap-2 items-start">
                <VendorPicker
                  vendors={vendors}
                  vendorId={billVendorId}
                  newVendorName={billNewVendorName}
                  onVendorIdChange={setBillVendorId}
                  onNewVendorNameChange={setBillNewVendorName}
                  allowCreate={permissions.canEditVendors}
                />
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">Due date</span>
                  <input
                    type="date"
                    value={billDue}
                    onChange={(e) => setBillDue(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                </label>
              </div>
              <div className="space-y-2">
                {billLines.map((line, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-slate-100 bg-white p-2 space-y-1.5"
                  >
                    <div className="grid grid-cols-12 gap-1.5 items-start">
                      <input
                        value={line.plantName}
                        onChange={(e) => {
                          const next = [...billLines];
                          next[idx] = { ...line, plantName: e.target.value };
                          setBillLines(next);
                        }}
                        placeholder="Plant or supply description"
                        className="col-span-11 sm:col-span-7 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                      />
                      <div className="col-span-11 sm:col-span-4">
                        <PurchaseCategoryField
                          value={line.category}
                          onChange={(category) => {
                            const next = [...billLines];
                            next[idx] = { ...line, category };
                            setBillLines(next);
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setBillLines(billLines.filter((_, i) => i !== idx))}
                        className="col-span-1 text-rose-600 flex items-center justify-center pt-2"
                        disabled={billLines.length === 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-12 gap-1.5">
                      {isPlantPurchaseCategory(line.category) && (
                        <label className="col-span-4 block">
                          <span className="text-[9px] font-bold uppercase text-slate-500">
                            Size
                          </span>
                          <input
                            value={line.containerSize}
                            onChange={(e) => {
                              const next = [...billLines];
                              next[idx] = { ...line, containerSize: e.target.value };
                              setBillLines(next);
                            }}
                            placeholder="#3, Tray…"
                            className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                          />
                        </label>
                      )}
                      <label
                        className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                      >
                        <span className="text-[9px] font-bold uppercase text-slate-500">Qty</span>
                        <input
                          type="number"
                          min={1}
                          value={line.quantity}
                          onChange={(e) => {
                            const next = [...billLines];
                            next[idx] = { ...line, quantity: Number(e.target.value) || 0 };
                            setBillLines(next);
                          }}
                          className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                        />
                      </label>
                      <label
                        className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                      >
                        <span className="text-[9px] font-bold uppercase text-slate-500">
                          Cost each
                        </span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={line.unitCost}
                          onChange={(e) => {
                            const next = [...billLines];
                            next[idx] = { ...line, unitCost: Number(e.target.value) || 0 };
                            setBillLines(next);
                          }}
                          placeholder="0.00"
                          className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                        />
                      </label>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setBillLines([...billLines, emptyBillLine()])}
                  className="text-[11px] font-bold text-ink-700"
                >
                  + Add line
                </button>
              </div>
              <textarea
                value={billNotes}
                onChange={(e) => setBillNotes(e.target.value)}
                placeholder="Notes"
                rows={2}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                Save bill
              </button>
            </form>
          )}

          <div className="space-y-2 max-h-[480px] overflow-y-auto">
            {filteredBills.length === 0 ? (
              <p className="text-xs text-gray-500 py-8 text-center">No vendor bills yet.</p>
            ) : (
              filteredBills.map((bill) => (
                <div
                  key={bill.id}
                  className="border border-gray-100 rounded-xl p-3 hover:border-ink-200 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-gray-900">
                        {bill.billNumber}
                        <span className="font-semibold text-gray-500"> · {bill.vendorName}</span>
                      </p>
                      <p className="text-xs text-gray-500">
                        {bill.billDate}
                        {bill.dueDate ? ` · Due ${bill.dueDate}` : ''}
                        {bill.vendorInvoiceNumber
                          ? ` · Inv ${bill.vendorInvoiceNumber}`
                          : ''}
                        {bill.poNumber ? ` · ${bill.poNumber}` : ''} · {money(bill.grandTotal)}
                      </p>
                      {bill.invoicePhotoUrl && (
                        <a
                          href={bill.invoicePhotoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] font-bold text-ink-700 hover:underline"
                        >
                          View scanned invoice
                        </a>
                      )}
                      {bill.items?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {[
                            ...new Set(
                              bill.items.map((line) =>
                                purchaseCategoryLabel(
                                  line.category ||
                                    (line.lineType === 'plant' ? 'Plants' : 'Other')
                                )
                              )
                            )
                          ].map((label) => (
                            <span
                              key={label}
                              className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${statusBadge(bill.status)}`}
                    >
                      {bill.status}
                    </span>
                  </div>
                  {permissions.canManageVendorBills && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {bill.status !== 'paid' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => markVendorBillPaid(bill))}
                          className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-emerald-700 text-white"
                        >
                          Mark paid
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            if (!confirm(`Delete ${bill.billNumber}?`)) return;
                            await deleteVendorBill(bill.id);
                          })
                        }
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg text-rose-700"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {receivingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 bg-ink-950 text-white flex items-center gap-2">
              <FileText className="h-4 w-4" />
              <div>
                <h3 className="text-sm font-black">Receive {receivingOrder.poNumber}</h3>
                <p className="text-[11px] text-white/70">{receivingOrder.vendorName}</p>
              </div>
            </div>
            <div className="p-4 space-y-2 max-h-[50vh] overflow-y-auto">
              <p className="text-[11px] text-slate-500">
                Enter qty received now. Inventory is updated only for these amounts.
              </p>
              {receivingOrder.items.map((line) => {
                const remaining = Math.max(
                  0,
                  line.quantityOrdered - (line.quantityReceived || 0)
                );
                return (
                  <div
                    key={line.id}
                    className="flex items-center justify-between gap-3 border border-slate-100 rounded-xl px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900 truncate">
                        {line.plantName}{' '}
                        <span className="text-slate-500 font-medium">{line.containerSize}</span>
                      </p>
                      <p className="text-[10px] text-slate-500">
                        Received {line.quantityReceived}/{line.quantityOrdered} · remaining{' '}
                        {remaining}
                      </p>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={remaining}
                      value={receiptQty[line.id] ?? 0}
                      onChange={(e) =>
                        setReceiptQty((prev) => ({
                          ...prev,
                          [line.id]: Number(e.target.value) || 0
                        }))
                      }
                      className="w-20 px-2 py-1.5 border border-gray-200 rounded-lg text-xs text-right font-mono"
                    />
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
              <button
                type="button"
                onClick={() => setReceivingOrder(null)}
                className="px-3 py-2 text-xs font-bold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReceive()}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                Receive into inventory
              </button>
            </div>
          </div>
        </div>
      )}

      {emailingOrder && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSendPoEmail}
            className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
          >
            <div className="px-5 py-4 bg-ink-950 text-white flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-sm font-black">Email {emailingOrder.poNumber}</h3>
                  <p className="text-[11px] text-white/70 truncate">
                    {emailingOrder.vendorName} · {money(emailingOrder.grandTotal)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEmailingOrder(null)}
                className="text-white/70 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <label className="block text-xs">
                <span className="font-bold text-slate-600">Vendor email</span>
                <input
                  type="email"
                  required
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="vendor@example.com"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="font-bold text-slate-600">Subject</span>
                <input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="font-bold text-slate-600">Message (optional)</span>
                <textarea
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  rows={3}
                  placeholder="Please confirm availability and ship date…"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <p className="text-[11px] text-slate-500">
                Email includes the full PO line items and totals. Draft POs are marked{' '}
                <span className="font-semibold">sent</span> after a successful send.
              </p>
              {emailStatus && (
                <p
                  className={`text-xs font-semibold rounded-lg px-3 py-2 ${
                    emailStatus.startsWith('Sent')
                      ? 'text-emerald-800 bg-emerald-50 border border-emerald-100'
                      : 'text-rose-700 bg-rose-50 border border-rose-100'
                  }`}
                >
                  {emailStatus}
                </p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
              <button
                type="button"
                onClick={() => setEmailingOrder(null)}
                className="px-3 py-2 text-xs font-bold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={emailSending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                <Mail className="h-3.5 w-3.5" />
                {emailSending ? 'Sending…' : 'Send PO'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
