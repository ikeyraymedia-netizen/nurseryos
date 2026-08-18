import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Upload,
  Users,
  Search,
  FileText,
  DollarSign,
  Plus,
  ArrowLeft,
  X,
  ClipboardList,
  Download,
  Mail
} from 'lucide-react';
import {
  Customer,
  CustomerOrder,
  CustomerDocument,
  CustomerDocumentType,
  ContainerWeight,
  PlantOrderItem,
  Truck
} from '../types';
import { addCustomer, bulkImportCustomers, countDuplicateCustomerNames, deduplicateCustomersByName, deleteAllCustomers, parseCsvCustomers, updateCustomer } from '../lib/customers';
import {
    listAllDocuments,
    subscribeToCustomerDocuments,
    subscribeToDocuments,
    updateCustomerDocument,
    deleteCustomerDocument
} from '../lib/documents';
import { addCustomerOrder } from '../lib/db';
import { logAuditEvent } from '../lib/audit';
import { exportNurseryBackup } from '../lib/backup';
import { AppPermissions } from '../lib/permissions';
import { useT } from '../lib/i18n';
import { looksLikeEmail, mailtoUrl, MAX_CC_RECIPIENTS, parseCcEmails, sendTenantEmail } from '../lib/email';
import { OutboundReplySelect } from './OutboundReplySelect';
import { EmailCcSection } from './EmailCcSection';
import {
  buildCustomerStatementEmailHtml,
  buildCustomerStatementEmailText,
  buildCustomerStatementModel,
  defaultCustomerStatementSubject
} from '../lib/customerStatementEmail';
import { formatPaymentRecord } from './MarkPaidModal';

type InvoicePeriod = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
type CustomersView = 'customers' | 'invoices';
type CustomerDocFilter = 'all' | CustomerDocumentType;

function startOfInvoicePeriod(period: InvoicePeriod, now = new Date()): Date | null {
  if (period === 'all') return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === 'day') return d;
  if (period === 'week') {
    const day = d.getDay(); // 0 Sun
    d.setDate(d.getDate() - day);
    return d;
  }
  if (period === 'month') {
    d.setDate(1);
    return d;
  }
  if (period === 'quarter') {
    const qMonth = Math.floor(d.getMonth() / 3) * 3;
    d.setMonth(qMonth, 1);
    return d;
  }
  // year
  d.setMonth(0, 1);
  return d;
}

function documentDateValue(doc: CustomerDocument): Date {
  const raw = doc.documentDate || doc.createdAt;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Unpaid/pending invoice past its due date (or invoice date when due is “Upon Receipt”). */
function isInvoiceOverdue(doc: CustomerDocument, now = new Date()): boolean {
  if (doc.paymentStatus === 'paid') return false;
  const today = startOfDay(now);
  let due: Date;
  if (doc.dueDate) {
    const parsed = new Date(doc.dueDate);
    if (Number.isNaN(parsed.getTime())) return false;
    due = startOfDay(parsed);
  } else {
    due = startOfDay(documentDateValue(doc));
  }
  return due.getTime() < today.getTime();
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

interface CustomersWorkspaceProps {
  customers: Customer[];
  orders: CustomerOrder[];
  trucks?: Truck[];
  permissions: AppPermissions;
  nurseryName?: string;
  tenantId?: string;
  containerWeights?: ContainerWeight[];
  initialSelectedCustomerId?: string | null;
  onOpenOrder?: (orderId: string) => void;
  onOpenDocument?: (
    orderId: string | null,
    type: CustomerDocumentType,
    existingDocument?: CustomerDocument | null,
    customerId?: string | null
  ) => void;
}

export function CustomersWorkspace({
  customers,
  orders,
  trucks = [],
  permissions,
  nurseryName = 'NurseryOS',
  tenantId,
  containerWeights = [],
  onOpenOrder,
  onOpenDocument,
  initialSelectedCustomerId
}: CustomersWorkspaceProps) {
  const t = useT();
  const NET_TERM_OPTIONS = ['NET 10', 'NET 15', 'NET 30', 'NET 45', 'NET 60', 'NET 90'] as const;
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<CustomersView>('customers');
  const [invoicePeriod, setInvoicePeriod] = useState<InvoicePeriod>('month');
  const [invoiceCustomerId, setInvoiceCustomerId] = useState<string>('all');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [allDocuments, setAllDocuments] = useState<CustomerDocument[]>([]);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [billingName, setBillingName] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [shippingName, setShippingName] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [pointOfContact, setPointOfContact] = useState('');
  const [paymentTermsType, setPaymentTermsType] = useState<string>('NET 30');
  const [customPaymentTerms, setCustomPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');

  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editBillingName, setEditBillingName] = useState('');
  const [editBillingAddress, setEditBillingAddress] = useState('');
  const [editShippingName, setEditShippingName] = useState('');
  const [editShippingAddress, setEditShippingAddress] = useState('');
  const [editPointOfContact, setEditPointOfContact] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editPaymentTermsType, setEditPaymentTermsType] = useState<string>('NET 30');
  const [editCustomPaymentTerms, setEditCustomPaymentTerms] = useState('');
  const [customerDocuments, setCustomerDocuments] = useState<CustomerDocument[]>([]);
  const [customerDocFilter, setCustomerDocFilter] = useState<CustomerDocFilter>('all');
  const [convertingDocId, setConvertingDocId] = useState<string | null>(null);
  const [showStatementEmail, setShowStatementEmail] = useState(false);
  const [statementEmailTo, setStatementEmailTo] = useState('');
  const [statementEmailCc, setStatementEmailCc] = useState('');
  const [statementEmailSubject, setStatementEmailSubject] = useState('');
  const [statementEmailMessage, setStatementEmailMessage] = useState('');
  const [statementEmailSending, setStatementEmailSending] = useState(false);
  const [statementEmailStatus, setStatementEmailStatus] = useState<string | null>(null);
  const [statementReplyTo, setStatementReplyTo] = useState('');

  const invoicePeriodLabels = useMemo(
    (): Array<[InvoicePeriod, string]> => [
      ['day', t('customers.today')],
      ['week', t('customers.thisWeek')],
      ['month', t('customers.thisMonth')],
      ['quarter', t('customers.thisQuarter')],
      ['year', t('customers.thisYear')],
      ['all', t('customers.allTime')]
    ],
    [t]
  );

  function permissionOrFallback(err: unknown, fallbackKey: string): string {
    const msg = String((err as { message?: string })?.message || '');
    if (
      msg.toLowerCase().includes('insufficient permissions') ||
      msg.toLowerCase().includes('permission-denied')
    ) {
      return t('customers.permissionDenied');
    }
    return msg || t(fallbackKey);
  }

  function orderStatusLabel(status: CustomerOrder['status']): string {
    switch (status) {
      case 'completed':
        return t('orders.statusCompleted');
      case 'loading':
        return t('orders.statusLoading');
      default:
        return t('orders.statusPending');
    }
  }

  function docTypeLabel(type: CustomerDocumentType): string {
    if (type === 'invoice') return t('customers.invoice');
    if (type === 'credit_memo') return t('customers.creditMemo');
    return t('customers.estimate');
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return customers;
    return customers.filter((c) =>
      [
        c.name,
        c.contactEmail || '',
        c.phone || '',
        c.billingName || '',
        c.billingAddress || '',
        c.shippingName || '',
        c.shippingAddress || c.receiverAddress || '',
        c.pointOfContact || '',
        c.paymentTerms || ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [customers, search]);

  const selectedCustomer = useMemo(
    () => filtered.find((c) => c.id === selectedCustomerId) || customers.find((c) => c.id === selectedCustomerId) || null,
    [filtered, customers, selectedCustomerId]
  );

  const selectedCustomerOrders = useMemo(() => {
    if (!selectedCustomer) return [];
    const normalizedName = selectedCustomer.name.trim().toLowerCase();
    return orders
      .filter((order) => {
        if (order.customerId && order.customerId === selectedCustomer.id) return true;
        return !order.customerId && order.customerName.trim().toLowerCase() === normalizedName;
      })
      .sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
  }, [orders, selectedCustomer]);

  const ordersByCustomerId = useMemo(() => {
    const map = new Map<string, CustomerOrder[]>();
    for (const customer of customers) {
      const normalizedName = customer.name.trim().toLowerCase();
      const matches = orders
        .filter((order) => {
          if (order.customerId && order.customerId === customer.id) return true;
          return !order.customerId && order.customerName.trim().toLowerCase() === normalizedName;
        })
        .sort((a, b) => b.dateCreated.localeCompare(a.dateCreated));
      map.set(customer.id, matches);
    }
    return map;
  }, [customers, orders]);

  useEffect(() => {
    if (!selectedCustomerId) {
      setCustomerDocuments([]);
      setShowStatementEmail(false);
      setStatementEmailStatus(null);
      return;
    }
    setCustomerDocFilter('all');
    setShowStatementEmail(false);
    setStatementEmailStatus(null);
    return subscribeToCustomerDocuments(selectedCustomerId, setCustomerDocuments);
  }, [selectedCustomerId]);

  const customerBalances = useMemo(() => {
    let unpaid = 0;
    let pastDue = 0;
    let credits = 0;
    for (const doc of customerDocuments) {
      if (doc.type === 'credit_memo') {
        credits += Math.abs(doc.grandTotal || 0);
        continue;
      }
      if (doc.type !== 'invoice') continue;
      if (doc.paymentStatus === 'paid') continue;
      const amount = doc.grandTotal || 0;
      unpaid += amount;
      if (isInvoiceOverdue(doc)) pastDue += amount;
    }
    return {
      totalDue: Math.max(0, unpaid - credits),
      totalPastDue: Math.max(0, pastDue)
    };
  }, [customerDocuments]);

  const customerStatement = useMemo(() => {
    if (!selectedCustomer) return null;
    return buildCustomerStatementModel({
      customer: selectedCustomer,
      documents: customerDocuments
    });
  }, [selectedCustomer, customerDocuments]);

  const filteredCustomerDocuments = useMemo(() => {
    if (customerDocFilter === 'all') return customerDocuments;
    return customerDocuments.filter((doc) => doc.type === customerDocFilter);
  }, [customerDocuments, customerDocFilter]);

  function openStatementEmailPanel() {
    if (!selectedCustomer || !customerStatement) return;
    setStatementEmailTo(selectedCustomer.contactEmail || '');
    setStatementEmailCc(selectedCustomer.contactEmailCc || '');
    setStatementEmailSubject(
      defaultCustomerStatementSubject(
        nurseryName,
        selectedCustomer.name,
        customerStatement.asOf
      )
    );
    setStatementEmailMessage('');
    setStatementEmailStatus(null);
    setShowStatementEmail(true);
  }

  async function handleSendStatementEmail(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canViewInvoices || !selectedCustomer || !customerStatement) return;
    if (!tenantId) {
      setStatementEmailStatus(t('customers.statementNurseryMissing'));
      return;
    }
    const to = statementEmailTo.trim();
    if (!looksLikeEmail(to)) {
      setStatementEmailStatus(t('customers.statementValidEmail'));
      return;
    }
    const { cc, invalid } = parseCcEmails(statementEmailCc, to);
    if (invalid.length) {
      setStatementEmailStatus(t('invoice.ccInvalid', { emails: invalid.join(', ') }));
      return;
    }
    if (cc.length > MAX_CC_RECIPIENTS) {
      setStatementEmailStatus(t('invoice.ccTooMany', { n: MAX_CC_RECIPIENTS }));
      return;
    }
    setStatementEmailSending(true);
    setStatementEmailStatus(null);
    try {
      const result = await sendTenantEmail({
        tenantId,
        to,
        cc,
        subject:
          statementEmailSubject.trim() ||
          defaultCustomerStatementSubject(
            nurseryName,
            selectedCustomer.name,
            customerStatement.asOf
          ),
        text: buildCustomerStatementEmailText({
          nurseryName,
          statement: customerStatement,
          message: statementEmailMessage
        }),
        html: buildCustomerStatementEmailHtml({
          nurseryName,
          statement: customerStatement,
          message: statementEmailMessage
        }),
        fromName: nurseryName,
        fromEmail: statementReplyTo || undefined
      });
      if (!result.success) {
        throw new Error(
          result.message || result.error || t('customers.statementEmailNotConfigured')
        );
      }
      if (
        permissions.canEditCustomers &&
        (to !== (selectedCustomer.contactEmail || '') ||
          (cc.join(', ') || '') !== (selectedCustomer.contactEmailCc || ''))
      ) {
        await updateCustomer({
          ...selectedCustomer,
          contactEmail: to,
          contactEmailCc: cc.join(', ') || undefined,
          updatedAt: new Date().toISOString()
        });
      }
      await logAuditEvent({
        action: 'customer.statement_emailed',
        summary: `Emailed account statement to ${to} for ${selectedCustomer.name}`,
        meta: {
          customerId: selectedCustomer.id,
          to,
          cc: cc.join(', '),
          totalDue: customerStatement.totalDue,
          totalPastDue: customerStatement.totalPastDue,
          lineCount: customerStatement.lines.length
        }
      });
      setStatementEmailStatus(t('customers.statementSent', { email: to }));
      window.setTimeout(() => {
        setShowStatementEmail(false);
        setStatementEmailStatus(null);
      }, 1400);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : t('customers.statementSendFailed');
      if (/firebase admin is not configured/i.test(raw)) {
        setStatementEmailStatus(t('customers.statementFirebaseAdminMissing'));
      } else {
        setStatementEmailStatus(raw);
      }
    } finally {
      setStatementEmailSending(false);
    }
  }

  function handleStatementMailto() {
    if (!selectedCustomer || !customerStatement) return;
    const to = statementEmailTo.trim();
    if (!looksLikeEmail(to)) {
      setStatementEmailStatus(t('customers.statementValidEmail'));
      return;
    }
    const { cc, invalid } = parseCcEmails(statementEmailCc, to);
    if (invalid.length) {
      setStatementEmailStatus(t('invoice.ccInvalid', { emails: invalid.join(', ') }));
      return;
    }
    if (cc.length > MAX_CC_RECIPIENTS) {
      setStatementEmailStatus(t('invoice.ccTooMany', { n: MAX_CC_RECIPIENTS }));
      return;
    }
    const subject =
      statementEmailSubject.trim() ||
      defaultCustomerStatementSubject(
        nurseryName,
        selectedCustomer.name,
        customerStatement.asOf
      );
    const body = buildCustomerStatementEmailText({
      nurseryName,
      statement: customerStatement,
      message: statementEmailMessage
    });
    window.location.href = mailtoUrl({ to, cc, subject, body });
  }

  useEffect(() => {
    if (workspaceView !== 'invoices' || !permissions.canViewInvoices) {
      return;
    }
    return subscribeToDocuments(setAllDocuments);
  }, [workspaceView, permissions.canViewInvoices]);

  const filteredInvoices = useMemo(() => {
    const periodStart = startOfInvoicePeriod(invoicePeriod);
    const q = invoiceSearch.toLowerCase().trim();
    return allDocuments
      .filter((doc) => doc.type === 'invoice')
      .filter((doc) => {
        if (invoiceCustomerId !== 'all' && doc.customerId !== invoiceCustomerId) return false;
        if (periodStart) {
          const docDate = documentDateValue(doc);
          if (docDate < periodStart) return false;
        }
        if (!q) return true;
        return [
          doc.documentNumber,
          doc.customerName,
          doc.billToName,
          doc.orderNumber || '',
          doc.paymentStatus || ''
        ]
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => documentDateValue(b).getTime() - documentDateValue(a).getTime());
  }, [allDocuments, invoicePeriod, invoiceCustomerId, invoiceSearch]);

  const invoiceTotals = useMemo(() => {
    let total = 0;
    let outstanding = 0;
    let overdue = 0;
    for (const doc of filteredInvoices) {
      const amount = doc.grandTotal || 0;
      total += amount;
      if (doc.paymentStatus !== 'paid') {
        outstanding += amount;
        if (isInvoiceOverdue(doc)) overdue += amount;
      }
    }
    return { total, outstanding, overdue, count: filteredInvoices.length };
  }, [filteredInvoices]);

  useEffect(() => {
    if (!initialSelectedCustomerId) return;
    setSelectedCustomerId(initialSelectedCustomerId);
  }, [initialSelectedCustomerId]);

  useEffect(() => {
    if (!selectedCustomer) return;
    setEditName(selectedCustomer.name || '');
    setEditEmail(selectedCustomer.contactEmail || '');
    setEditPhone(selectedCustomer.phone || '');
    setEditBillingName(selectedCustomer.billingName || '');
    setEditBillingAddress(selectedCustomer.billingAddress || '');
    setEditShippingName(selectedCustomer.shippingName || '');
    setEditShippingAddress(selectedCustomer.shippingAddress || selectedCustomer.receiverAddress || '');
    setEditPointOfContact(selectedCustomer.pointOfContact || '');
    setEditNotes(selectedCustomer.notes || '');

    const currentTerms = (selectedCustomer.paymentTerms || '').trim().toUpperCase();
    if (!currentTerms) {
      setEditPaymentTermsType('NET 30');
      setEditCustomPaymentTerms('');
    } else if (currentTerms === 'COD') {
      setEditPaymentTermsType('COD');
      setEditCustomPaymentTerms('');
    } else if ((NET_TERM_OPTIONS as readonly string[]).includes(currentTerms)) {
      setEditPaymentTermsType(currentTerms);
      setEditCustomPaymentTerms('');
    } else {
      setEditPaymentTermsType('CUSTOM');
      setEditCustomPaymentTerms(selectedCustomer.paymentTerms || '');
    }
  }, [selectedCustomer]);

  async function handleAddCustomer(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canEditCustomers) return;
    if (!name.trim()) {
      setMessage(t('customers.nameRequired'));
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const newId = await addCustomer({
        name: name.trim(),
        contactEmail: email.trim() || undefined,
        phone: phone.trim() || undefined,
        billingName: billingName.trim() || undefined,
        billingAddress: billingAddress.trim() || undefined,
        shippingName: shippingName.trim() || undefined,
        shippingAddress: shippingAddress.trim() || undefined,
        receiverAddress: shippingAddress.trim() || undefined,
        pointOfContact: pointOfContact.trim() || undefined,
        paymentTerms:
          paymentTermsType === 'CUSTOM'
            ? customPaymentTerms.trim() || undefined
            : paymentTermsType || undefined,
        notes: notes.trim() || undefined
      });
      setName('');
      setEmail('');
      setPhone('');
      setBillingName('');
      setBillingAddress('');
      setShippingName('');
      setShippingAddress('');
      setPointOfContact('');
      setPaymentTermsType('NET 30');
      setCustomPaymentTerms('');
      setNotes('');
      setShowAddForm(false);
      setSelectedCustomerId(newId);
      setMessage(t('customers.saved'));
    } catch (err: any) {
      setMessage(permissionOrFallback(err, 'customers.addFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSelectedCustomer() {
    if (!permissions.canEditCustomers || !selectedCustomer) return;
    if (!editName.trim()) {
      setMessage(t('customers.nameRequired'));
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await updateCustomer({
        ...selectedCustomer,
        name: editName.trim(),
        contactEmail: editEmail.trim() || undefined,
        phone: editPhone.trim() || undefined,
        billingName: editBillingName.trim() || undefined,
        billingAddress: editBillingAddress.trim() || undefined,
        shippingName: editShippingName.trim() || undefined,
        shippingAddress: editShippingAddress.trim() || undefined,
        receiverAddress: editShippingAddress.trim() || undefined,
        pointOfContact: editPointOfContact.trim() || undefined,
        paymentTerms:
          editPaymentTermsType === 'CUSTOM'
            ? editCustomPaymentTerms.trim() || undefined
            : editPaymentTermsType || undefined,
        notes: editNotes.trim() || undefined,
        updatedAt: new Date().toISOString()
      });
      setMessage(t('customers.updated'));
    } catch (err: any) {
      setMessage(err?.message || t('customers.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCsvUpload(file: File) {
    if (!permissions.canEditCustomers) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const parsed = parseCsvCustomers(text);
      if (parsed.length === 0) {
        throw new Error(t('customers.csvFormatError'));
      }
      const count = await bulkImportCustomers(parsed);
      setMessage(
        count === 0
          ? t('customers.noNewImported')
          : t('customers.importedCustomers', { n: count })
      );
    } catch (err: any) {
      setMessage(permissionOrFallback(err, 'customers.csvImportFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeduplicateCustomers() {
    if (!permissions.canEditCustomers) return;
    const extras = countDuplicateCustomerNames(customers);
    if (extras === 0) {
      setMessage(t('customers.noDuplicates'));
      return;
    }
    const ok = window.confirm(t('customers.dedupeConfirm', { n: extras }));
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await deduplicateCustomersByName();
      if (result.removed === 0) {
        setMessage(t('customers.noDuplicatesRemoved'));
      } else {
        setMessage(
          t('customers.dedupeResult', {
            removed: result.removed,
            groups: result.duplicateGroups,
            orders: result.remappedOrders,
            documents: result.remappedDocuments
          })
        );
      }
    } catch (err: any) {
      setMessage(err?.message || t('customers.dedupeFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleExportBackup() {
    if (!permissions.canEditCustomers) return;
    setBusy(true);
    setMessage(null);
    try {
      const documents = await listAllDocuments();
      exportNurseryBackup({
        nurseryName,
        customers,
        orders,
        trucks,
        documents
      });
      await logAuditEvent({
        action: 'backup.exported',
        summary: `Exported backup (${customers.length} customers, ${orders.length} orders, ${documents.length} documents)`,
        meta: {
          customers: customers.length,
          orders: orders.length,
          trucks: trucks.length,
          documents: documents.length
        }
      });
      setMessage(t('customers.backupDownloaded'));
    } catch (err: any) {
      setMessage(err?.message || t('customers.backupFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAllCustomers() {
    if (!permissions.canEditCustomers) return;
    if (customers.length === 0) {
      setMessage(t('customers.noCustomersToDelete'));
      return;
    }
    const ok = window.confirm(t('customers.deleteAllConfirm', { n: customers.length }));
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const count = await deleteAllCustomers();
      setSelectedCustomerId(null);
      setMessage(t('customers.removedCustomers', { n: count }));
    } catch (err: any) {
      setMessage(err?.message || t('customers.deleteCustomersFailed'));
    } finally {
      setBusy(false);
    }
  }

  function estimateWeightLbs(doc: CustomerDocument): number {
    return (doc.items || []).reduce((total, item) => {
      const match = containerWeights.find(
        (w) =>
          w.id.toLowerCase() === item.containerSize.toLowerCase() ||
          w.label.toLowerCase() === item.containerSize.toLowerCase()
      );
      const unitWeight = match ? match.weightLbs : 0;
      return total + unitWeight * (item.quantity || 0);
    }, 0);
  }

  async function handleDeleteSavedDocument(doc: CustomerDocument) {
    if (!permissions.canViewInvoices) return;
    const ok = window.confirm(
      t('customers.deleteDocConfirm', { doc: doc.documentNumber })
    );
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteCustomerDocument(doc.id);
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : t('customers.deleteDocFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleConvertEstimateToOrder(doc: CustomerDocument) {
    if (!permissions.canUploadOrders || !selectedCustomer) return;
    if (doc.type !== 'estimate') return;
    if (doc.orderId) {
      onOpenOrder?.(doc.orderId);
      return;
    }

    const ok = window.confirm(
      t('customers.convertConfirm', { doc: doc.documentNumber, customer: selectedCustomer.name })
    );
    if (!ok) return;

    setConvertingDocId(doc.id);
    setMessage(null);
    try {
      const items: PlantOrderItem[] = (doc.items || []).map((item, index) => ({
        id: item.id || `item-${Date.now()}-${index}`,
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: item.quantity,
        loadedQuantity: 0,
        unitPrice: item.unitPrice,
        unitCost: item.unitCost,
        notes: item.notes,
        substitutes: item.substitutes,
        vendor: item.vendor
      }));

      if (items.length === 0) {
        throw new Error(t('customers.noLineItems'));
      }

      const orderId = await addCustomerOrder({
        customerName: selectedCustomer.name,
        customerId: selectedCustomer.id,
        orderNumber: doc.orderNumber || doc.documentNumber.replace(/^EST-/i, '') || 'N/A',
        items,
        originalText: `Converted from estimate ${doc.documentNumber}`,
        status: 'pending',
        totalWeightLbs: estimateWeightLbs(doc),
        customerEmail: doc.customerEmail || selectedCustomer.contactEmail,
        customerEmailCc: doc.customerEmailCc || selectedCustomer.contactEmailCc,
        invoiceDetails: {
          invoiceNumber: doc.documentNumber,
          invoiceDate: doc.documentDate,
          dueDate: doc.dueDate,
          paymentTerms: doc.paymentTerms,
          taxRate: doc.taxRate,
          freightCharge: doc.freightCharge,
          discount: doc.discount,
          notes: doc.notes
        }
      });

      await updateCustomerDocument({
        ...doc,
        orderId,
        updatedAt: new Date().toISOString()
      });

      await logAuditEvent({
        action: 'estimate.converted_to_order',
        summary: `Converted ${doc.documentNumber} to order for ${selectedCustomer.name}`,
        meta: { estimateId: doc.id, orderId, customerId: selectedCustomer.id }
      });

      setMessage(t('customers.convertSuccess'));
      onOpenOrder?.(orderId);
    } catch (err: any) {
      setMessage(err?.message || t('customers.convertFailed'));
    } finally {
      setConvertingDocId(null);
    }
  }

  return (
    <div className="space-y-6">
      {selectedCustomer ? (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-ink-100 p-5">
            <button
              type="button"
              onClick={() => {
                setSelectedCustomerId(null);
                setMessage(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-800 hover:text-ink-950 mb-3"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('customers.back')}
            </button>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-ink-50 flex items-center justify-center shrink-0">
                <Users className="h-5 w-5 text-ink-700" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900 truncate">{selectedCustomer.name}</h2>
                <p className="text-xs text-gray-500">
                  {[selectedCustomer.contactEmail, selectedCustomer.phone].filter(Boolean).join(' • ') ||
                    t('customers.noContact')}
                </p>
              </div>
            </div>
            {permissions.canViewInvoices && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-ink-100 bg-ink-50/50 p-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-ink-700">
                      {t('customers.totalDue')}
                    </p>
                    <p className="mt-1 text-xl font-black text-gray-950 tabular-nums">
                      {formatMoney(customerBalances.totalDue)}
                    </p>
                  </div>
                  <div
                    className={`rounded-xl border p-3 ${
                      customerBalances.totalPastDue > 0
                        ? 'border-rose-200 bg-rose-50/70'
                        : 'border-slate-200 bg-slate-50/70'
                    }`}
                  >
                    <p
                      className={`text-[10px] font-black uppercase tracking-wider ${
                        customerBalances.totalPastDue > 0 ? 'text-rose-800' : 'text-slate-600'
                      }`}
                    >
                      {t('customers.totalPastDue')}
                    </p>
                    <p
                      className={`mt-1 text-xl font-black tabular-nums ${
                        customerBalances.totalPastDue > 0 ? 'text-rose-900' : 'text-gray-950'
                      }`}
                    >
                      {formatMoney(customerBalances.totalPastDue)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      showStatementEmail
                        ? setShowStatementEmail(false)
                        : openStatementEmailPanel()
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {showStatementEmail
                      ? t('customers.hideStatementEmail')
                      : t('customers.emailStatement')}
                  </button>
                </div>
                {showStatementEmail && customerStatement && (
                  <form
                    onSubmit={handleSendStatementEmail}
                    className="rounded-xl border border-ink-100 bg-ink-50/40 p-3 space-y-2"
                  >
                    <p className="text-[10px] font-black uppercase tracking-wider text-ink-800">
                      {t('customers.emailStatementTitle')}
                    </p>
                    <p className="text-[11px] text-slate-600">
                      {t('customers.emailStatementHint', {
                        due: formatMoney(customerStatement.totalDue),
                        pastDue: formatMoney(customerStatement.totalPastDue),
                        n: customerStatement.lines.length
                      })}
                    </p>
                    <input
                      type="email"
                      value={statementEmailTo}
                      onChange={(e) => setStatementEmailTo(e.target.value)}
                      placeholder={t('customers.statementEmailPlaceholder')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={statementEmailSending}
                      required
                    />
                    <EmailCcSection
                      value={statementEmailCc}
                      onChange={setStatementEmailCc}
                      toEmail={statementEmailTo}
                      disabled={statementEmailSending}
                    />
                    {tenantId ? (
                      <OutboundReplySelect
                        tenantId={tenantId}
                        value={statementReplyTo}
                        onChange={(email) => setStatementReplyTo(email)}
                        disabled={statementEmailSending}
                      />
                    ) : null}
                    <input
                      type="text"
                      value={statementEmailSubject}
                      onChange={(e) => setStatementEmailSubject(e.target.value)}
                      placeholder={t('customers.statementSubjectPlaceholder')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={statementEmailSending}
                    />
                    <textarea
                      rows={2}
                      value={statementEmailMessage}
                      onChange={(e) => setStatementEmailMessage(e.target.value)}
                      placeholder={t('customers.statementMessagePlaceholder')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={statementEmailSending}
                    />
                    {statementEmailStatus && (
                      <p className="text-[11px] font-medium text-ink-800 bg-white border border-ink-100 rounded-lg px-2.5 py-1.5">
                        {statementEmailStatus}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="submit"
                        disabled={statementEmailSending || !tenantId}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-50"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        {statementEmailSending
                          ? t('customers.sendingStatement')
                          : t('customers.sendStatement')}
                      </button>
                      <button
                        type="button"
                        onClick={handleStatementMailto}
                        disabled={statementEmailSending}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-ink-200 bg-white text-ink-800 text-xs font-bold hover:bg-ink-50 disabled:opacity-50"
                      >
                        {t('customers.openMailApp')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {message && (
              <p className="mt-3 text-xs font-medium text-ink-800 bg-ink-50 border border-ink-100 rounded-lg px-3 py-2">
                {message}
              </p>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-ink-800 mb-1.5">
                  {t('customers.billTo')}
                </p>
                <p className="text-sm font-bold text-gray-900">
                  {selectedCustomer.billingName?.trim() || selectedCustomer.name}
                </p>
                <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">
                  {selectedCustomer.billingAddress?.trim() || t('customers.noBillTo')}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-ink-800 mb-1.5">
                  {t('customers.shipTo')}
                </p>
                <p className="text-sm font-bold text-gray-900">
                  {selectedCustomer.shippingName?.trim() || selectedCustomer.name}
                </p>
                <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">
                  {(
                    selectedCustomer.shippingAddress ||
                    selectedCustomer.receiverAddress ||
                    ''
                  ).trim() || t('customers.noShipTo')}
                </p>
              </div>
            </div>
            {(selectedCustomer.pointOfContact || selectedCustomer.paymentTerms) && (
              <div>
                {selectedCustomer.pointOfContact && (
                  <p className="text-xs text-gray-600">
                    {t('customers.pointOfContact')} {selectedCustomer.pointOfContact}
                  </p>
                )}
                {selectedCustomer.paymentTerms && (
                  <p className="text-xs text-gray-600 mt-1">
                    {t('customers.terms')} {selectedCustomer.paymentTerms}
                  </p>
                )}
              </div>
            )}

            {permissions.canEditCustomers && (
              <div className="border-t border-gray-100 pt-4 space-y-3">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">{t('customers.editCustomer')}</p>
                <div className="grid md:grid-cols-2 gap-3">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={t('customers.customerName')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    placeholder={t('customers.email')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder={t('customers.phone')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editPointOfContact}
                    onChange={(e) => setEditPointOfContact(e.target.value)}
                    placeholder={t('customers.pointOfContactPlaceholder')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />

                  <div className="md:col-span-2 rounded-xl border border-ink-100 bg-ink-50/40 p-3 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-ink-800">
                      {t('customers.billTo')}
                    </p>
                    <input
                      value={editBillingName}
                      onChange={(e) => setEditBillingName(e.target.value)}
                      placeholder={t('customers.billToName')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                    <textarea
                      rows={3}
                      value={editBillingAddress}
                      onChange={(e) => setEditBillingAddress(e.target.value)}
                      placeholder={t('customers.billToAddress')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  </div>

                  <div className="md:col-span-2 rounded-xl border border-sky-100 bg-sky-50/40 p-3 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-sky-800">
                      {t('customers.shipTo')}
                    </p>
                    <input
                      value={editShippingName}
                      onChange={(e) => setEditShippingName(e.target.value)}
                      placeholder={t('customers.shipToName')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                    <textarea
                      rows={3}
                      value={editShippingAddress}
                      onChange={(e) => setEditShippingAddress(e.target.value)}
                      placeholder={t('customers.shipToAddress')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  </div>

                  <select
                    value={editPaymentTermsType}
                    onChange={(e) => setEditPaymentTermsType(e.target.value)}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  >
                    {NET_TERM_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                    <option value="COD">{t('customers.cod')}</option>
                    <option value="CUSTOM">{t('customers.custom')}</option>
                  </select>
                  {editPaymentTermsType === 'CUSTOM' && (
                    <input
                      value={editCustomPaymentTerms}
                      onChange={(e) => setEditCustomPaymentTerms(e.target.value)}
                      placeholder={t('customers.customTerms')}
                      className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                      disabled={busy}
                    />
                  )}
                  <input
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder={t('customers.notes')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleSaveSelectedCustomer}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-50"
                >
                  {t('customers.saveChanges')}
                </button>
              </div>
            )}

            <div className="border-t border-gray-100 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  {t('customers.estimatesInvoices', {
                    n:
                      customerDocFilter === 'all'
                        ? customerDocuments.length
                        : filteredCustomerDocuments.length
                  })}
                </p>
                {permissions.canViewInvoices && onOpenDocument && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenDocument(null, 'credit_memo', null, selectedCustomer.id)
                    }
                    className="inline-flex items-center gap-1 text-xs font-bold text-rose-800 hover:text-rose-950"
                  >
                    <DollarSign className="h-3.5 w-3.5" />
                    {t('customers.newCreditMemo')}
                  </button>
                )}
              </div>
              {customerDocuments.length > 0 && (
                <div className="mb-3 inline-flex flex-wrap rounded-xl border border-ink-200 overflow-hidden">
                  {(
                    [
                      ['all', t('customers.filterAll')],
                      ['invoice', t('customers.filterInvoices')],
                      ['estimate', t('customers.filterEstimates')],
                      ['credit_memo', t('customers.filterCreditMemos')]
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCustomerDocFilter(id)}
                      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${
                        customerDocFilter === id
                          ? 'bg-ink-700 text-white'
                          : 'bg-white text-ink-800 hover:bg-ink-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {customerDocuments.length === 0 ? (
                <p className="text-xs text-gray-500 mb-3">
                  {t('customers.noDocsHint')}
                </p>
              ) : filteredCustomerDocuments.length === 0 ? (
                <p className="text-xs text-gray-500 mb-3">{t('customers.noDocsFiltered')}</p>
              ) : (
                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1 mb-3">
                  {filteredCustomerDocuments.map((doc) => (
                    <div key={doc.id} className="border border-gray-100 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900 truncate">{doc.documentNumber}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(doc.documentDate).toLocaleDateString()} • ${doc.grandTotal.toFixed(2)}
                            {doc.orderNumber ? ` • ${t('customers.orderNum')}${doc.orderNumber}` : ''}
                            {doc.referencedInvoiceNumber
                              ? ` • ${t('customers.refInvoice')}${doc.referencedInvoiceNumber}`
                              : ''}
                            {doc.poNumber ? ` • ${t('customers.poNum')}${doc.poNumber}` : ''}
                            {doc.type === 'invoice' && doc.paymentStatus === 'paid'
                              ? ` • ${t('customers.balance')}`
                              : ''}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span
                            className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${
                              doc.type === 'invoice'
                                ? 'bg-ink-100 text-ink-800'
                                : doc.type === 'credit_memo'
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-sky-100 text-sky-800'
                            }`}
                          >
                            {docTypeLabel(doc.type)}
                          </span>
                          {doc.type === 'invoice' && doc.paymentStatus === 'paid' && (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-emerald-700 text-white">
                              {t('customers.paid')}
                            </span>
                          )}
                          {doc.type === 'invoice' && doc.paymentStatus === 'pending' && (
                            <span className="text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-amber-100 text-amber-800">
                              {t('customers.pending')}
                            </span>
                          )}
                        </div>
                      </div>
                      {doc.type === 'invoice' &&
                        doc.paymentStatus === 'paid' &&
                        (doc.paymentMethod || doc.paymentReference) && (
                          <p className="text-[10px] font-semibold text-emerald-800 mt-1">
                            {formatPaymentRecord(t, doc.paymentMethod, doc.paymentReference)}
                          </p>
                        )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {permissions.canViewInvoices && onOpenDocument && (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.orderId || null, doc.type, doc)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-ink-700 hover:text-ink-800"
                          >
                            <DollarSign className="h-3.5 w-3.5" />
                            {t('customers.openDoc', { type: docTypeLabel(doc.type) })}
                          </button>
                        )}
                        {permissions.canViewInvoices && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDeleteSavedDocument(doc)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-rose-700 hover:text-rose-800 disabled:opacity-50"
                          >
                            {t('common.delete')}
                          </button>
                        )}
                        {permissions.canUploadOrders && doc.type === 'estimate' && !doc.orderId && (
                          <button
                            type="button"
                            disabled={convertingDocId === doc.id || busy}
                            onClick={() => handleConvertEstimateToOrder(doc)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-sky-800 hover:text-sky-950 disabled:opacity-50"
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            {convertingDocId === doc.id ? t('customers.converting') : t('customers.convertToOrder')}
                          </button>
                        )}
                        {permissions.canViewOrders && doc.type === 'estimate' && doc.orderId && onOpenOrder && (
                          <button
                            type="button"
                            onClick={() => onOpenOrder(doc.orderId!)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-sky-800 hover:text-sky-950"
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            {t('customers.openLinkedOrder')}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
                {t('customers.orders', { n: selectedCustomerOrders.length })}
              </p>
              {selectedCustomerOrders.length === 0 ? (
                <p className="text-xs text-gray-500">{t('customers.noOrders')}</p>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                  {selectedCustomerOrders.map((order) => (
                    <div key={order.id} className="border border-gray-100 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900 truncate">
                            {t('customers.orderNum')}{order.orderNumber}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(order.dateCreated).toLocaleDateString()} • {order.items.length} {t('customers.items')}
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${
                            order.status === 'completed'
                              ? 'bg-ink-100 text-ink-800'
                              : order.status === 'loading'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {orderStatusLabel(order.status)}
                        </span>
                      </div>
                      {onOpenOrder && (
                        <button
                          type="button"
                          onClick={() => onOpenOrder(order.id)}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-ink-700 hover:text-ink-800"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          {t('customers.openOrder')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-ink-100 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-ink-50 flex items-center justify-center">
                  {workspaceView === 'invoices' ? (
                    <FileText className="h-5 w-5 text-ink-700" />
                  ) : (
                    <Users className="h-5 w-5 text-ink-700" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    {workspaceView === 'invoices' ? t('customers.invoices') : t('customers.workspaceTitle')}
                  </h2>
                  <p className="text-xs text-gray-500">
                    {workspaceView === 'invoices'
                      ? t('customers.invoicesSubtitle')
                      : t('customers.customersSubtitle')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {permissions.canViewInvoices && (
                  <div className="inline-flex rounded-xl border border-ink-200 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceView('customers');
                        setMessage(null);
                      }}
                      className={`px-3 py-2 text-xs font-bold ${
                        workspaceView === 'customers'
                          ? 'bg-ink-700 text-white'
                          : 'bg-white text-ink-800 hover:bg-ink-50'
                      }`}
                    >
                      {t('customers.customers')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceView('invoices');
                        setShowAddForm(false);
                        setMessage(null);
                      }}
                      className={`px-3 py-2 text-xs font-bold inline-flex items-center gap-1.5 ${
                        workspaceView === 'invoices'
                          ? 'bg-ink-700 text-white'
                          : 'bg-white text-ink-800 hover:bg-ink-50'
                      }`}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {t('customers.invoices')}
                    </button>
                  </div>
                )}
                {workspaceView === 'customers' && permissions.canEditCustomers && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm((open) => !open);
                      setMessage(null);
                    }}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800"
                  >
                    {showAddForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {showAddForm ? t('common.close') : t('customers.addCustomer')}
                  </button>
                )}
              </div>
            </div>

            {workspaceView === 'invoices' ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {invoicePeriodLabels.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setInvoicePeriod(id)}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border ${
                        invoicePeriod === id
                          ? 'bg-ink-700 text-white border-ink-700'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="grid sm:grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {t('customers.customer')}
                    </span>
                    <select
                      value={invoiceCustomerId}
                      onChange={(e) => setInvoiceCustomerId(e.target.value)}
                      className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    >
                      <option value="all">{t('customers.allCustomers')}</option>
                      {[...customers]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {t('common.search')}
                    </span>
                    <div className="relative mt-1">
                      <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
                      <input
                        value={invoiceSearch}
                        onChange={(e) => setInvoiceSearch(e.target.value)}
                        placeholder={t('customers.searchPlaceholder')}
                        className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
                      />
                    </div>
                  </label>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-slate-500">{t('customers.invoicesCount')}</p>
                    <p className="text-sm font-black text-slate-900">{invoiceTotals.count}</p>
                  </div>
                  <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-ink-700">{t('customers.total')}</p>
                    <p className="text-sm font-black text-ink-900">
                      {formatMoney(invoiceTotals.total)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-amber-700">{t('customers.outstanding')}</p>
                    <p className="text-sm font-black text-amber-900">
                      {formatMoney(invoiceTotals.outstanding)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-rose-100 bg-rose-50/60 px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-rose-700">{t('customers.overdue')}</p>
                    <p className="text-sm font-black text-rose-900">
                      {formatMoney(invoiceTotals.overdue)}
                    </p>
                  </div>
                </div>

                <div className="space-y-2 max-h-[480px] overflow-y-auto">
                  {filteredInvoices.length === 0 ? (
                    <p className="text-xs text-gray-500 py-6 text-center">
                      {t('customers.noInvoices')}
                    </p>
                  ) : (
                    filteredInvoices.map((doc) => (
                      <div
                        key={doc.id}
                        className="border border-gray-100 rounded-xl p-3 hover:border-ink-200 hover:bg-ink-50/40 transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-gray-900 truncate">
                              {doc.documentNumber}
                              <span className="font-semibold text-gray-500"> · {doc.customerName}</span>
                            </p>
                            <p className="text-xs text-gray-500">
                              {documentDateValue(doc).toLocaleDateString()} • $
                              {(doc.grandTotal || 0).toFixed(2)}
                              {doc.orderNumber ? ` • ${t('customers.orderNum')}${doc.orderNumber}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            {doc.paymentStatus === 'paid' ? (
                              <span className="text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-emerald-700 text-white">
                                {t('customers.paid')}
                              </span>
                            ) : doc.paymentStatus === 'pending' ? (
                              <span className="text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-amber-100 text-amber-800">
                                {t('customers.pending')}
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold px-2 py-1 rounded-full uppercase bg-slate-100 text-slate-700">
                                {t('customers.unpaid')}
                              </span>
                            )}
                          </div>
                        </div>
                        {doc.paymentStatus === 'paid' &&
                          (doc.paymentMethod || doc.paymentReference) && (
                            <p className="text-[10px] font-semibold text-emerald-800 mt-1">
                              {formatPaymentRecord(t, doc.paymentMethod, doc.paymentReference)}
                            </p>
                          )}
                        {onOpenDocument && (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.orderId || null, doc.type, doc)}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-ink-700 hover:text-ink-800"
                          >
                            <DollarSign className="h-3.5 w-3.5" />
                            {t('customers.openInvoice')}
                          </button>
                        )}
                        {permissions.canViewInvoices && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDeleteSavedDocument(doc)}
                            className="mt-2 ml-3 inline-flex items-center gap-1 text-xs font-bold text-rose-700 hover:text-rose-800 disabled:opacity-50"
                          >
                            {t('common.delete')}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <>
            {permissions.canEditCustomers && (
              <div className="flex flex-wrap gap-2 mb-4">
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-ink-200 bg-ink-50 text-ink-800 text-xs font-bold cursor-pointer hover:bg-ink-100">
                  <Upload className="h-4 w-4" />
                  {t('customers.uploadCsv')}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCsvUpload(file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleExportBackup()}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
                >
                  <Download className="h-4 w-4" />
                  {t('customers.exportBackup')}
                </button>
                {countDuplicateCustomerNames(customers) > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDeduplicateCustomers}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-xs font-bold hover:bg-amber-100 disabled:opacity-50"
                  >
                    {t('customers.removeDuplicates', { n: countDuplicateCustomerNames(customers) })}
                  </button>
                )}
                {customers.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDeleteAllCustomers}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                  >
                    {t('customers.deleteAll')}
                  </button>
                )}
              </div>
            )}

            {message && (
              <p className="text-xs font-medium text-ink-800 bg-ink-50 border border-ink-100 rounded-lg px-3 py-2 mb-4">
                {message}
              </p>
            )}

            {permissions.canEditCustomers && showAddForm && (
              <form
                onSubmit={handleAddCustomer}
                className="border border-gray-200 rounded-2xl p-4 space-y-3 bg-slate-50/60 mb-4"
              >
                <h3 className="text-sm font-bold text-gray-900">{t('customers.newCustomer')}</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('customers.customerNameRequired')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('customers.contactEmail')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={t('customers.phone')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t('customers.notes')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={pointOfContact}
                    onChange={(e) => setPointOfContact(e.target.value)}
                    placeholder={t('customers.pointOfContactPlaceholder')}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />

                  <div className="md:col-span-2 rounded-xl border border-ink-100 bg-ink-50/40 p-3 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-ink-800">
                      {t('customers.billTo')}
                    </p>
                    <input
                      value={billingName}
                      onChange={(e) => setBillingName(e.target.value)}
                      placeholder={t('customers.billToName')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                    <textarea
                      rows={3}
                      value={billingAddress}
                      onChange={(e) => setBillingAddress(e.target.value)}
                      placeholder={t('customers.billToAddress')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  </div>

                  <div className="md:col-span-2 rounded-xl border border-sky-100 bg-sky-50/40 p-3 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-sky-800">
                      {t('customers.shipTo')}
                    </p>
                    <input
                      value={shippingName}
                      onChange={(e) => setShippingName(e.target.value)}
                      placeholder={t('customers.shipToName')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                    <textarea
                      rows={3}
                      value={shippingAddress}
                      onChange={(e) => setShippingAddress(e.target.value)}
                      placeholder={t('customers.shipToAddress')}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  </div>

                  <select
                    value={paymentTermsType}
                    onChange={(e) => setPaymentTermsType(e.target.value)}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  >
                    {NET_TERM_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                    <option value="COD">{t('customers.cod')}</option>
                    <option value="CUSTOM">{t('customers.custom')}</option>
                  </select>
                  {paymentTermsType === 'CUSTOM' && (
                    <input
                      value={customPaymentTerms}
                      onChange={(e) => setCustomPaymentTerms(e.target.value)}
                      placeholder={t('customers.customTerms')}
                      className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  )}
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold hover:bg-ink-800 disabled:opacity-50"
                >
                  {t('customers.saveCustomer')}
                </button>
              </form>
            )}

            <div className="relative mb-3">
              <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('customers.searchCustomer')}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
              />
            </div>

            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-xs text-gray-500">{t('customers.noCustomers')}</p>
              ) : (
                filtered.map((c) => {
                  const rowOrders = ordersByCustomerId.get(c.id) || [];
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setShowAddForm(false);
                        setSelectedCustomerId(c.id);
                        setMessage(null);
                      }}
                      className="w-full text-left border border-gray-100 rounded-xl p-3 transition hover:bg-ink-50/50 hover:border-ink-200"
                    >
                      <p className="text-sm font-bold text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-500">
                        {[c.contactEmail, c.phone].filter(Boolean).join(' • ') || t('customers.noContact')}
                      </p>
                      <p className="text-[11px] text-ink-700 font-semibold mt-1">
                        {t('customers.ordersCount', { n: rowOrders.length })}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
