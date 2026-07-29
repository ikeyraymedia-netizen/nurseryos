import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  ClipboardList,
  FileText,
  Mail,
  PackagePlus,
  Pencil,
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
  VendorBill,
  VendorBillLine
} from '../types';
import { AppPermissions } from '../lib/permissions';
import { useT } from '../lib/i18n';
import { dueDateFromPaymentTerms, toDateKey } from '../lib/dates';
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
  subscribeToVendorBills,
  updateVendorBill
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
import { formatPaymentRecord, MarkPaidModal } from './MarkPaidModal';
import { BillEditModal } from './BillEditModal';

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
  return toDateKey(new Date());
}

function emptyLine(): Omit<PurchaseOrderLine, 'id' | 'quantityReceived'> {
  return {
    plantName: '',
    containerSize: '',
    quantityOrdered: 1,
    unitCost: 0
  };
}

type BillFormLine = {
  id?: string;
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  category: string;
};

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

const CATEGORY_I18N: Record<string, string> = {
  Plants: 'category.plants',
  'Soil / media': 'category.soil',
  'Containers / trays': 'category.containers',
  Chemicals: 'category.chemicals',
  Fertilizer: 'category.fertilizer',
  Freight: 'category.freight',
  Fuel: 'category.fuel',
  'Tools / equipment': 'category.tools',
  'General supplies': 'category.supplies',
  Other: 'category.other'
};

function translateCategory(t: (key: string) => string, label: string): string {
  const key = CATEGORY_I18N[label];
  return key ? t(key) : label;
}

function translateStatus(t: (key: string) => string, status: string): string {
  const map: Record<string, string> = {
    draft: 'purchasing.statusDraft',
    sent: 'purchasing.statusSent',
    partial: 'purchasing.statusPartial',
    received: 'purchasing.statusReceived',
    cancelled: 'purchasing.statusCancelled',
    unpaid: 'purchasing.statusUnpaid',
    paid: 'purchasing.statusPaid'
  };
  const key = map[status];
  return key ? t(key) : status;
}

export function PurchasingWorkspace({
  permissions,
  tenantId,
  nurseryName
}: PurchasingWorkspaceProps) {
  const t = useT();
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
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

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
  const [editingBill, setEditingBill] = useState<VendorBill | null>(null);
  const [billVendorId, setBillVendorId] = useState('');
  const [billNewVendorName, setBillNewVendorName] = useState('');
  const [billDate, setBillDate] = useState(() => todayKey());
  const [billDue, setBillDue] = useState('');
  const [billVendorInvoice, setBillVendorInvoice] = useState('');
  const [billNotes, setBillNotes] = useState('');
  const [billLines, setBillLines] = useState<BillFormLine[]>([emptyBillLine()]);
  const [markingPaidBill, setMarkingPaidBill] = useState<VendorBill | null>(null);

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

  const selectedVendor = useMemo(
    () =>
      selectedVendorId
        ? vendors.find((v) => v.id === selectedVendorId) || null
        : null,
    [vendors, selectedVendorId]
  );

  const selectedVendorBills = useMemo(() => {
    if (!selectedVendorId) return [];
    let list = bills.filter((b) => b.vendorId === selectedVendorId);
    if (q) {
      list = list.filter((b) =>
        [b.billNumber, b.vendorName, b.status, b.poNumber, b.vendorInvoiceNumber]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    return list.sort((a, b) => (b.billDate || '').localeCompare(a.billDate || ''));
  }, [bills, selectedVendorId, q]);

  const billsByVendorId = useMemo(() => {
    const map = new Map<string, { count: number; outstanding: number }>();
    for (const bill of bills) {
      const cur = map.get(bill.vendorId) || { count: 0, outstanding: 0 };
      cur.count += 1;
      if (bill.status !== 'paid') cur.outstanding += bill.grandTotal || 0;
      map.set(bill.vendorId, cur);
    }
    return map;
  }, [bills]);

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
      .map(([id, amount]) => ({ id, label: translateCategory(t, id), amount }))
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
  }, [bills, monthKey, t]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('purchasing.somethingWentWrong'));
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
      setError(t('purchasing.pickVendor'));
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
      setError(t('purchasing.addLineItem'));
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
      setEmailStatus(t('purchasing.validEmail'));
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
          result.message || result.error || t('purchasing.emailNotConfigured')
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

      setEmailStatus(t('purchasing.sentTo', { email: to }));
      window.setTimeout(() => {
        setEmailingOrder(null);
        setEmailStatus(null);
      }, 1200);
    } catch (err: unknown) {
      setEmailStatus(err instanceof Error ? err.message : t('purchasing.couldNotSendEmail'));
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

  const selectedBillVendorTerms = vendors.find((v) => v.id === billVendorId)?.paymentTerms;

  function applyVendorTermsToDueDate(vendorId: string, dateKey: string) {
    if (!vendorId || vendorId === CREATE_NEW_VENDOR) return;
    const vendor = vendors.find((v) => v.id === vendorId);
    const terms = vendor?.paymentTerms;
    if (!terms) return;
    const due = dueDateFromPaymentTerms(dateKey || todayKey(), terms);
    if (due) setBillDue(due);
  }

  // Keep due date in sync when vendor terms load/update or bill date changes
  useEffect(() => {
    if (!showBillForm || editingBill) return;
    if (!billVendorId || billVendorId === CREATE_NEW_VENDOR) return;
    if (!selectedBillVendorTerms) return;
    const due = dueDateFromPaymentTerms(billDate || todayKey(), selectedBillVendorTerms);
    if (due) setBillDue(due);
  }, [showBillForm, editingBill, billVendorId, billDate, selectedBillVendorTerms]);

  function openNewBill(prefillVendorId?: string) {
    setEditingBill(null);
    setBillVendorId(prefillVendorId || '');
    setBillNewVendorName('');
    setBillDate(todayKey());
    setBillDue('');
    setBillVendorInvoice('');
    setBillNotes('');
    setBillLines([emptyBillLine()]);
    setShowInvoiceScanner(false);
    setShowBillForm(true);
    if (prefillVendorId) {
      applyVendorTermsToDueDate(prefillVendorId, todayKey());
    }
  }

  function openEditBill(bill: VendorBill) {
    setShowBillForm(false);
    setShowInvoiceScanner(false);
    setError(null);
    setEditingBill(bill);
  }

  function closeBillForm() {
    setShowBillForm(false);
    setEditingBill(null);
    setBillVendorId('');
    setBillNewVendorName('');
    setBillDate(todayKey());
    setBillDue('');
    setBillVendorInvoice('');
    setBillNotes('');
    setBillLines([emptyBillLine()]);
  }

  async function handleSaveBill(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canManageVendorBills) return;

    let vendor = vendors.find((v) => v.id === billVendorId) || null;
    if (billVendorId === CREATE_NEW_VENDOR) {
      const name = billNewVendorName.trim();
      if (!name) {
        setError(t('purchasing.enterVendorName'));
        return;
      }
      if (!permissions.canEditVendors) {
        setError(t('purchasing.needVendorPermission'));
        return;
      }
    } else if (!vendor) {
      setError(t('purchasing.pickSavedVendor'));
      return;
    }

    const items = billLines
      .map((l, idx) => ({
        id: l.id || `vbl-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        plantName: l.plantName.trim(),
        containerSize: isPlantPurchaseCategory(l.category)
          ? l.containerSize.trim() || 'Other'
          : l.containerSize.trim(),
        quantity: Math.max(0, Number(l.quantity) || 0),
        unitCost: Math.max(0, Number(l.unitCost) || 0),
        category: resolvePurchaseCategory(l.category)
      }))
      .filter((l) => l.plantName && l.quantity > 0) as VendorBillLine[];
    if (items.length === 0) {
      setError(t('purchasing.addLineRequired'));
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

      const resolvedDue =
        billDue.trim() ||
        dueDateFromPaymentTerms(billDate || todayKey(), vendor.paymentTerms) ||
        undefined;

      await createVendorBill({
        vendorId: vendor.id,
        vendorName: vendor.name,
        billDate: billDate || undefined,
        dueDate: resolvedDue,
        vendorInvoiceNumber: billVendorInvoice.trim() || undefined,
        notes: billNotes.trim() || undefined,
        items
      });
      closeBillForm();
    });
  }

  async function handleSaveEditedBill(updated: VendorBill) {
    setBusy(true);
    setError(null);
    try {
      let vendorId = updated.vendorId;
      let vendorName = updated.vendorName;
      if (vendorId === CREATE_NEW_VENDOR) {
        if (!permissions.canEditVendors) {
          throw new Error(t('purchasing.needVendorPermission'));
        }
        const name = vendorName.trim();
        if (!name) throw new Error(t('purchasing.enterVendorName'));
        vendorId = await addVendor({ name });
        vendorName = name;
      }
      await updateVendorBill({
        ...updated,
        vendorId,
        vendorName
      });
      setEditingBill(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('purchasing.somethingWentWrong');
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setBusy(false);
    }
  }

  function renderBillCard(bill: VendorBill) {
    return (
      <div
        key={bill.id}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (permissions.canManageVendorBills) openEditBill(bill);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (permissions.canManageVendorBills) openEditBill(bill);
          }
        }}
        className={`border rounded-xl p-3 transition text-left w-full ${
          editingBill?.id === bill.id
            ? 'border-ink-400 bg-ink-50/30'
            : 'border-gray-100 hover:border-ink-200 cursor-pointer'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-gray-900">
              {bill.billNumber}
              {!selectedVendorId && (
                <span className="font-semibold text-gray-500"> · {bill.vendorName}</span>
              )}
            </p>
            <p className="text-xs text-gray-500">
              {bill.billDate}
              {bill.dueDate ? ` · ${t('purchasing.due')} ${bill.dueDate}` : ''}
              {bill.vendorInvoiceNumber
                ? ` · ${t('purchasing.invPrefix')} ${bill.vendorInvoiceNumber}`
                : ''}
              {bill.poNumber ? ` · ${bill.poNumber}` : ''} · {money(bill.grandTotal)}
            </p>
            {bill.status === 'paid' && (bill.paymentMethod || bill.paymentReference) && (
              <p className="text-[11px] font-bold text-emerald-800 mt-1">
                {formatPaymentRecord(t, bill.paymentMethod, bill.paymentReference)}
                {bill.paidAt ? ` · ${new Date(bill.paidAt).toLocaleDateString()}` : ''}
              </p>
            )}
            {bill.items?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[
                  ...new Set(
                    bill.items.map((line) =>
                      translateCategory(
                        t,
                        purchaseCategoryLabel(
                          line.category || (line.lineType === 'plant' ? 'Plants' : 'Other')
                        )
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
            {translateStatus(t, bill.status)}
          </span>
        </div>
        {bill.invoicePhotoUrl && (
          <a
            href={bill.invoicePhotoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block mt-1.5 text-[11px] font-bold text-ink-700 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {t('purchasing.viewScannedInvoice')}
          </a>
        )}
        {permissions.canManageVendorBills && (
          <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={busy}
              onClick={() => openEditBill(bill)}
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-800"
            >
              <Pencil className="h-3 w-3" />
              {t('purchasing.edit')}
            </button>
            {bill.status !== 'paid' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMarkingPaidBill(bill)}
                className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-emerald-700 text-white"
              >
                {t('purchasing.markPaid')}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  if (
                    !confirm(t('purchasing.deleteBillConfirm', { billNumber: bill.billNumber }))
                  )
                    return;
                  if (editingBill?.id === bill.id) setEditingBill(null);
                  await deleteVendorBill(bill.id);
                })
              }
              className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg text-rose-700"
            >
              {t('common.delete')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-ink-100 p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-ink-50 flex items-center justify-center">
            <PackagePlus className="h-5 w-5 text-ink-700" />
          </div>
          <div>
            <h2 className="text-base font-black text-slate-900 tracking-tight">{t('purchasing.title')}</h2>
            <p className="text-xs text-slate-500">{t('purchasing.subtitle')}</p>
          </div>
        </div>
        <div className="inline-flex rounded-xl border border-ink-200 overflow-hidden">
          {(
            [
              ['orders', t('purchasing.pos'), ClipboardList],
              ['vendors', t('purchasing.vendors'), Building2],
              ['bills', t('purchasing.bills'), Receipt]
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setView(id);
                if (id !== 'vendors') setSelectedVendorId(null);
              }}
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
            view === 'vendors' && selectedVendor
              ? t('purchasing.searchVendorBills')
              : view === 'vendors'
                ? t('purchasing.searchVendors')
                : view === 'orders'
                  ? t('purchasing.searchPos')
                  : t('purchasing.searchBills')
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
              <p className="text-[10px] font-bold uppercase text-slate-500">{t('purchasing.bills')}</p>
              <p className="text-sm font-black text-slate-900">{billTotals.count}</p>
            </div>
            <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2">
              <p className="text-[10px] font-bold uppercase text-amber-700">{t('purchasing.outstanding')}</p>
              <p className="text-sm font-black text-amber-900">{money(billTotals.outstanding)}</p>
            </div>
            <div className="rounded-xl border border-rose-100 bg-rose-50/60 px-3 py-2">
              <p className="text-[10px] font-bold uppercase text-rose-700">{t('purchasing.overdue')}</p>
              <p className="text-sm font-black text-rose-900">{money(billTotals.overdue)}</p>
            </div>
          </div>

          <div className="rounded-xl border border-ink-100 bg-ink-50/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-900">
                {t('purchasing.purchasesMonth')}
              </p>
              <p className="text-sm font-black text-ink-900">{money(monthPurchases.total)}</p>
            </div>
            <p className="text-[11px] text-slate-500">
              {t('purchasing.billCount', { n: monthPurchases.billCount })}
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
              <p className="text-[11px] text-slate-500">{t('purchasing.noPurchases')}</p>
            )}
          </div>
        </div>
      )}

      {view === 'vendors' && selectedVendor ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-4">
            <button
              type="button"
              onClick={() => {
                setSelectedVendorId(null);
                setSearch('');
              }}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-800 hover:text-ink-950 mb-3"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('purchasing.backToVendors')}
            </button>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-gray-900 truncate">{selectedVendor.name}</h3>
                <p className="text-xs text-gray-500">
                  {[selectedVendor.contactName, selectedVendor.contactEmail, selectedVendor.phone]
                    .filter(Boolean)
                    .join(' · ') || t('purchasing.noContact')}
                </p>
                {selectedVendor.paymentTerms && (
                  <p className="text-[11px] text-ink-700 mt-1">
                    {t('purchasing.terms', { terms: selectedVendor.paymentTerms })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                {permissions.canEditVendors && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingVendorId(selectedVendor.id);
                      setVendorName(selectedVendor.name);
                      setVendorEmail(selectedVendor.contactEmail || '');
                      setVendorPhone(selectedVendor.phone || '');
                      setVendorContact(selectedVendor.contactName || '');
                      setVendorTerms(selectedVendor.paymentTerms || '');
                      setSelectedVendorId(null);
                    }}
                    className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-800"
                  >
                    <Pencil className="h-3 w-3" />
                    {t('common.edit')}
                  </button>
                )}
                {permissions.canManageVendorBills && (
                  <button
                    type="button"
                    onClick={() => {
                      setView('bills');
                      openNewBill(selectedVendor.id);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-700 text-white text-[10px] font-bold"
                  >
                    <Plus className="h-3 w-3" />
                    {t('purchasing.newBill')}
                  </button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <div className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                <p className="text-[10px] font-bold uppercase text-slate-500">
                  {t('purchasing.bills')}
                </p>
                <p className="text-sm font-black text-slate-900">
                  {billsByVendorId.get(selectedVendor.id)?.count || 0}
                </p>
              </div>
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                <p className="text-[10px] font-bold uppercase text-amber-700">
                  {t('purchasing.outstanding')}
                </p>
                <p className="text-sm font-black text-amber-900">
                  {money(billsByVendorId.get(selectedVendor.id)?.outstanding || 0)}
                </p>
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-wide text-ink-900 mb-2">
              {t('purchasing.billsForVendor', { name: selectedVendor.name })}
            </p>
            <div className="space-y-2 max-h-[480px] overflow-y-auto">
              {selectedVendorBills.length === 0 ? (
                <p className="text-xs text-gray-500 py-8 text-center">
                  {t('purchasing.noBillsForVendor')}
                </p>
              ) : (
                selectedVendorBills.map((bill) => renderBillCard(bill))
              )}
            </div>
          </div>
        </div>
      ) : (
        view === 'vendors' && (
          <>
            {permissions.canManageVendorBills && (
              <div className="space-y-2">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowInvoiceScanner((o) => !o)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold"
                  >
                    <ScanLine className="h-3.5 w-3.5" />
                    {showInvoiceScanner
                      ? t('purchasing.hideInvoiceScan')
                      : t('purchasing.scanInvoice')}
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

            <div className="grid lg:grid-cols-5 gap-4">
              {permissions.canEditVendors && (
                <form
                  onSubmit={handleSaveVendor}
                  className="lg:col-span-2 rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-2"
                >
                  <p className="text-xs font-bold uppercase tracking-wide text-ink-900">
                    {editingVendorId ? t('purchasing.editVendor') : t('purchasing.addVendor')}
                  </p>
                  <input
                    required
                    value={vendorName}
                    onChange={(e) => setVendorName(e.target.value)}
                    placeholder={t('purchasing.vendorName')}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  <input
                    value={vendorContact}
                    onChange={(e) => setVendorContact(e.target.value)}
                    placeholder={t('purchasing.contactName')}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  <input
                    value={vendorEmail}
                    onChange={(e) => setVendorEmail(e.target.value)}
                    placeholder={t('common.email')}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  <input
                    value={vendorPhone}
                    onChange={(e) => setVendorPhone(e.target.value)}
                    placeholder={t('customers.phone')}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  <label className="block text-xs space-y-1">
                    <span className="font-bold text-slate-600">{t('purchasing.paymentTerms')}</span>
                    <select
                      value={
                        ['Net 15', 'Net 30', 'Net 45', 'Net 60', 'Due on Receipt', 'COD'].includes(
                          vendorTerms
                        )
                          ? vendorTerms
                          : ''
                      }
                      onChange={(e) => {
                        if (e.target.value) setVendorTerms(e.target.value);
                      }}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                    >
                      <option value="">{t('purchasing.selectTerms')}</option>
                      <option value="Net 15">Net 15</option>
                      <option value="Net 30">Net 30</option>
                      <option value="Net 45">Net 45</option>
                      <option value="Net 60">Net 60</option>
                      <option value="Due on Receipt">Due on Receipt</option>
                      <option value="COD">COD</option>
                    </select>
                    <input
                      value={vendorTerms}
                      onChange={(e) => setVendorTerms(e.target.value)}
                      placeholder={t('purchasing.paymentTermsPlaceholder')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
                    >
                      {editingVendorId ? t('common.save') : t('purchasing.addVendorBtn')}
                    </button>
                    {editingVendorId && (
                      <button
                        type="button"
                        onClick={resetVendorForm}
                        className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-600"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </form>
              )}
              <div
                className={`${permissions.canEditVendors ? 'lg:col-span-3' : 'lg:col-span-5'} space-y-2 max-h-[520px] overflow-y-auto`}
              >
                {filteredVendors.length === 0 ? (
                  <p className="text-xs text-gray-500 py-8 text-center">
                    {t('purchasing.noVendors')}
                  </p>
                ) : (
                  filteredVendors.map((v) => {
                    const stats = billsByVendorId.get(v.id);
                    return (
                      <div
                        key={v.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedVendorId(v.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedVendorId(v.id);
                          }
                        }}
                        className="border border-gray-100 rounded-xl p-3 hover:border-ink-200 transition cursor-pointer text-left"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-gray-900">{v.name}</p>
                            <p className="text-xs text-gray-500">
                              {[v.contactName, v.contactEmail, v.phone]
                                .filter(Boolean)
                                .join(' · ') || t('purchasing.noContact')}
                            </p>
                            {v.paymentTerms && (
                              <p className="text-[11px] text-ink-700 mt-1">
                                {t('purchasing.terms', { terms: v.paymentTerms })}
                              </p>
                            )}
                            <p className="text-[11px] text-slate-600 mt-1.5">
                              {t('purchasing.vendorBillSummary', {
                                count: stats?.count || 0,
                                outstanding: money(stats?.outstanding || 0)
                              })}
                            </p>
                          </div>
                          {permissions.canEditVendors && (
                            <div
                              className="flex gap-1 shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
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
                                {t('common.edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void run(async () => {
                                    if (!confirm(t('purchasing.deleteVendor', { name: v.name })))
                                      return;
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
                    );
                  })
                )}
              </div>
            </div>
          </>
        )
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
                {t('purchasing.newPo')}
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
                  <span className="font-bold text-slate-600">{t('purchasing.vendorLabel')}</span>
                  <select
                    required
                    value={poVendorId}
                    onChange={(e) => setPoVendorId(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  >
                    <option value="">{t('purchasing.selectVendor')}</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">{t('purchasing.expected')}</span>
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
                      placeholder={t('purchasing.plant')}
                      className="col-span-4 px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                    />
                    <input
                      value={line.containerSize}
                      onChange={(e) => {
                        const next = [...poLines];
                        next[idx] = { ...line, containerSize: e.target.value };
                        setPoLines(next);
                      }}
                      placeholder={t('purchasing.size')}
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
                      placeholder={t('common.qty')}
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
                      placeholder={t('purchasing.cost')}
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
                  {t('purchasing.addLine')}
                </button>
              </div>
              <textarea
                value={poNotes}
                onChange={(e) => setPoNotes(e.target.value)}
                placeholder={t('purchasing.notes')}
                rows={2}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={busy || vendors.length === 0}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {t('purchasing.createPo')}
              </button>
              {vendors.length === 0 && (
                <p className="text-[11px] text-amber-700">{t('purchasing.addVendorFirst')}</p>
              )}
            </form>
          )}

          <div className="space-y-2 max-h-[520px] overflow-y-auto">
            {filteredOrders.length === 0 ? (
              <p className="text-xs text-gray-500 py-8 text-center">{t('purchasing.noPos')}</p>
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
                        {order.expectedDate ? ` · ${t('purchasing.due')} ${order.expectedDate}` : ''} ·{' '}
                        {money(order.grandTotal)} · {order.items.length}{' '}
                        {t('purchasing.lines')}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${statusBadge(order.status)}`}
                    >
                      {translateStatus(t, order.status)}
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
                      <li className="text-slate-400">{t('purchasing.moreLines', { n: order.items.length - 4 })}</li>
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
                          {t('purchasing.emailVendor')}
                        </button>
                      )}
                    {permissions.canEditPurchaseOrders && order.status === 'draft' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => markPurchaseOrderSent(order))}
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-700 text-white"
                      >
                        {t('purchasing.markSent')}
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
                          {t('purchasing.receive')}
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
                        {t('purchasing.createBill')}
                      </button>
                    )}
                    {permissions.canEditPurchaseOrders && order.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            if (!confirm(t('purchasing.deletePoConfirm', { poNumber: order.poNumber })))
                              return;
                            await deletePurchaseOrder(order.id);
                          })
                        }
                        className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg text-rose-700"
                      >
                        {t('common.delete')}
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
                  if (!showInvoiceScanner) closeBillForm();
                  else setShowBillForm(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-ink-200 bg-white text-ink-800 text-xs font-bold"
              >
                <ScanLine className="h-3.5 w-3.5" />
                {showInvoiceScanner ? t('purchasing.hideScan') : t('purchasing.scanInvoiceBtn')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (showBillForm && !editingBill) {
                    closeBillForm();
                  } else {
                    openNewBill();
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('purchasing.newBill')}
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

          {showBillForm && !editingBill && permissions.canManageVendorBills && (
            <form
              onSubmit={handleSaveBill}
              className="rounded-xl border border-ink-100 bg-ink-50/40 p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-black uppercase tracking-wide text-ink-900">
                  {t('purchasing.newBill')}
                </p>
                <button
                  type="button"
                  onClick={closeBillForm}
                  className="text-xs font-bold text-slate-500 hover:text-slate-800"
                >
                  {t('common.cancel')}
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 items-start">
                <VendorPicker
                  vendors={vendors}
                  vendorId={billVendorId}
                  newVendorName={billNewVendorName}
                  onVendorIdChange={(id) => {
                    setBillVendorId(id);
                    if (id && id !== CREATE_NEW_VENDOR) {
                      applyVendorTermsToDueDate(id, billDate || todayKey());
                    }
                  }}
                  onNewVendorNameChange={setBillNewVendorName}
                  allowCreate={permissions.canEditVendors}
                />
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">{t('purchasing.billDate')}</span>
                  <input
                    type="date"
                    value={billDate}
                    onChange={(e) => {
                      const next = e.target.value;
                      setBillDate(next);
                      if (billVendorId && billVendorId !== CREATE_NEW_VENDOR) {
                        applyVendorTermsToDueDate(billVendorId, next || todayKey());
                      }
                    }}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">{t('purchasing.dueDate')}</span>
                  <input
                    type="date"
                    value={billDue}
                    onChange={(e) => setBillDue(e.target.value)}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                  />
                  {billVendorId &&
                    billVendorId !== CREATE_NEW_VENDOR &&
                    vendors.find((v) => v.id === billVendorId)?.paymentTerms && (
                      <span className="mt-1 block text-[10px] text-slate-500">
                        {t('purchasing.terms', {
                          terms: vendors.find((v) => v.id === billVendorId)?.paymentTerms || ''
                        })}
                      </span>
                    )}
                </label>
                <label className="block text-xs">
                  <span className="font-bold text-slate-600">{t('purchasing.vendorInvoiceNumber')}</span>
                  <input
                    value={billVendorInvoice}
                    onChange={(e) => setBillVendorInvoice(e.target.value)}
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
                        placeholder={t('purchasing.description')}
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
                            {t('purchasing.size')}
                          </span>
                          <input
                            value={line.containerSize}
                            onChange={(e) => {
                              const next = [...billLines];
                              next[idx] = { ...line, containerSize: e.target.value };
                              setBillLines(next);
                            }}
                            placeholder={t('purchasing.sizePlaceholder')}
                            className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                          />
                        </label>
                      )}
                      <label
                        className={`block ${isPlantPurchaseCategory(line.category) ? 'col-span-4' : 'col-span-6'}`}
                      >
                        <span className="text-[9px] font-bold uppercase text-slate-500">
                          {t('common.qty')}
                        </span>
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
                          {t('purchasing.costEach')}
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
                  {t('purchasing.addLine')}
                </button>
              </div>
              <textarea
                value={billNotes}
                onChange={(e) => setBillNotes(e.target.value)}
                placeholder={t('purchasing.notes')}
                rows={2}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {t('purchasing.saveBill')}
              </button>
            </form>
          )}

          <div className="space-y-2 max-h-[480px] overflow-y-auto">
            {filteredBills.length === 0 ? (
              <p className="text-xs text-gray-500 py-8 text-center">{t('purchasing.noBills')}</p>
            ) : (
              filteredBills.map((bill) => renderBillCard(bill))
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
                <h3 className="text-sm font-black">
                  {t('purchasing.receiveTitle', { poNumber: receivingOrder.poNumber })}
                </h3>
                <p className="text-[11px] text-white/70">{receivingOrder.vendorName}</p>
              </div>
            </div>
            <div className="p-4 space-y-2 max-h-[50vh] overflow-y-auto">
              <p className="text-[11px] text-slate-500">
                {t('purchasing.receiveHint')}
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
                        {t('purchasing.receivedProgress', {
                          received: line.quantityReceived,
                          ordered: line.quantityOrdered,
                          remaining
                        })}
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
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReceive()}
                className="px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {t('purchasing.receiveIntoInventory')}
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
                  <h3 className="text-sm font-black">
                    {t('purchasing.emailPoTitle', { poNumber: emailingOrder.poNumber })}
                  </h3>
                  <p className="text-[11px] text-white/70 truncate">
                    {emailingOrder.vendorName} · {money(emailingOrder.grandTotal)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEmailingOrder(null)}
                className="text-white/70 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <label className="block text-xs">
                <span className="font-bold text-slate-600">{t('purchasing.vendorEmailLabel')}</span>
                <input
                  type="email"
                  required
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder={t('purchasing.emailPlaceholder')}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="font-bold text-slate-600">{t('purchasing.subjectLabel')}</span>
                <input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="font-bold text-slate-600">{t('purchasing.messageOptional')}</span>
                <textarea
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  rows={3}
                  placeholder={t('purchasing.messagePlaceholder')}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </label>
              <p className="text-[11px] text-slate-500">{t('purchasing.emailPoHint')}</p>
              {emailStatus && (
                <p
                  className={`text-xs font-semibold rounded-lg px-3 py-2 ${
                    emailStatus.startsWith(
                      t('purchasing.sentTo', { email: '' }).replace('{{email}}', '').trim()
                    )
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
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={emailSending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
              >
                <Mail className="h-3.5 w-3.5" />
                {emailSending ? t('invoice.sending') : t('purchasing.sendPo')}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingBill && (
        <BillEditModal
          bill={editingBill}
          vendors={vendors}
          busy={busy}
          canCreateVendor={permissions.canEditVendors}
          onClose={() => setEditingBill(null)}
          onSave={handleSaveEditedBill}
        />
      )}

      {markingPaidBill && (
        <MarkPaidModal
          title={t('purchasing.markPaid')}
          subtitle={`${markingPaidBill.billNumber} · ${markingPaidBill.vendorName}`}
          amountLabel={money(markingPaidBill.grandTotal)}
          busy={busy}
          onCancel={() => setMarkingPaidBill(null)}
          onConfirm={async (payment) => {
            await run(async () => {
              await markVendorBillPaid(markingPaidBill, payment);
              setMarkingPaidBill(null);
            });
          }}
        />
      )}
    </div>
  );
}
