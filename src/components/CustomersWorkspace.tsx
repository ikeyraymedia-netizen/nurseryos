import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Upload, Users, Search, FileText, DollarSign, Plus, ArrowLeft, X, ClipboardList, Download } from 'lucide-react';
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
import { listAllDocuments, subscribeToCustomerDocuments, updateCustomerDocument } from '../lib/documents';
import { addCustomerOrder } from '../lib/db';
import { logAuditEvent } from '../lib/audit';
import { exportNurseryBackup } from '../lib/backup';
import { AppPermissions } from '../lib/permissions';

interface CustomersWorkspaceProps {
  customers: Customer[];
  orders: CustomerOrder[];
  trucks?: Truck[];
  permissions: AppPermissions;
  nurseryName?: string;
  containerWeights?: ContainerWeight[];
  initialSelectedCustomerId?: string | null;
  onOpenOrder?: (orderId: string) => void;
  onOpenDocument?: (
    orderId: string | null,
    type: CustomerDocumentType,
    existingDocument?: CustomerDocument | null
  ) => void;
}

export function CustomersWorkspace({
  customers,
  orders,
  trucks = [],
  permissions,
  nurseryName = 'NurseryOS',
  containerWeights = [],
  onOpenOrder,
  onOpenDocument,
  initialSelectedCustomerId
}: CustomersWorkspaceProps) {
  const NET_TERM_OPTIONS = ['NET 10', 'NET 15', 'NET 30', 'NET 45', 'NET 60', 'NET 90'] as const;
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [pointOfContact, setPointOfContact] = useState('');
  const [paymentTermsType, setPaymentTermsType] = useState<string>('NET 30');
  const [customPaymentTerms, setCustomPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');

  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editBillingAddress, setEditBillingAddress] = useState('');
  const [editShippingAddress, setEditShippingAddress] = useState('');
  const [editPointOfContact, setEditPointOfContact] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editPaymentTermsType, setEditPaymentTermsType] = useState<string>('NET 30');
  const [editCustomPaymentTerms, setEditCustomPaymentTerms] = useState('');
  const [customerDocuments, setCustomerDocuments] = useState<CustomerDocument[]>([]);
  const [convertingDocId, setConvertingDocId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return customers;
    return customers.filter((c) =>
      [
        c.name,
        c.contactEmail || '',
        c.phone || '',
        c.billingAddress || '',
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
      return;
    }
    return subscribeToCustomerDocuments(selectedCustomerId, setCustomerDocuments);
  }, [selectedCustomerId]);

  useEffect(() => {
    if (!initialSelectedCustomerId) return;
    setSelectedCustomerId(initialSelectedCustomerId);
  }, [initialSelectedCustomerId]);

  useEffect(() => {
    if (!selectedCustomer) return;
    setEditName(selectedCustomer.name || '');
    setEditEmail(selectedCustomer.contactEmail || '');
    setEditPhone(selectedCustomer.phone || '');
    setEditBillingAddress(selectedCustomer.billingAddress || '');
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
    if (!permissions.canEditOrders) return;
    if (!name.trim()) {
      setMessage('Customer name is required.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const newId = await addCustomer({
        name: name.trim(),
        contactEmail: email.trim() || undefined,
        phone: phone.trim() || undefined,
        billingAddress: billingAddress.trim() || undefined,
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
      setBillingAddress('');
      setShippingAddress('');
      setPointOfContact('');
      setPaymentTermsType('NET 30');
      setCustomPaymentTerms('');
      setNotes('');
      setShowAddForm(false);
      setSelectedCustomerId(newId);
      setMessage('Customer saved.');
    } catch (err: any) {
      const msg = String(err?.message || '');
      setMessage(
        msg.toLowerCase().includes('insufficient permissions') || msg.toLowerCase().includes('permission-denied')
          ? 'Permission denied. Publish the latest firestore.rules in Firebase Console (Rules tab on your AI Studio database), then hard refresh and try again.'
          : msg || 'Failed to add customer.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSelectedCustomer() {
    if (!permissions.canEditOrders || !selectedCustomer) return;
    if (!editName.trim()) {
      setMessage('Customer name is required.');
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
        billingAddress: editBillingAddress.trim() || undefined,
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
      setMessage('Customer updated.');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to update customer.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCsvUpload(file: File) {
    if (!permissions.canEditOrders) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const parsed = parseCsvCustomers(text);
      if (parsed.length === 0) {
        throw new Error('CSV needs a name header (optional: email, phone, notes).');
      }
      const count = await bulkImportCustomers(parsed);
      setMessage(
        count === 0
          ? 'No new customers imported (names already in your list were skipped).'
          : `Imported ${count} new customer${count === 1 ? '' : 's'} (existing names were skipped).`
      );
    } catch (err: any) {
      const msg = String(err?.message || '');
      setMessage(
        msg.toLowerCase().includes('insufficient permissions') || msg.toLowerCase().includes('permission-denied')
          ? 'Permission denied. Publish the latest firestore.rules in Firebase Console (Rules tab on your AI Studio database), then hard refresh and try again.'
          : msg || 'Customer CSV import failed.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDeduplicateCustomers() {
    if (!permissions.canEditOrders) return;
    const extras = countDuplicateCustomerNames(customers);
    if (extras === 0) {
      setMessage('No duplicate customer names found.');
      return;
    }
    const ok = window.confirm(
      `Found about ${extras} duplicate customer record${extras === 1 ? '' : 's'} (same name more than once).\n\nKeep the most complete copy of each name, remove the extras, and re-link any orders/estimates that pointed at a removed copy?`
    );
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await deduplicateCustomersByName();
      if (result.removed === 0) {
        setMessage('No duplicates needed removing.');
      } else {
        setMessage(
          `Removed ${result.removed} duplicate${result.removed === 1 ? '' : 's'} across ${result.duplicateGroups} name${result.duplicateGroups === 1 ? '' : 's'}. Relinked ${result.remappedOrders} order${result.remappedOrders === 1 ? '' : 's'} and ${result.remappedDocuments} document${result.remappedDocuments === 1 ? '' : 's'}.`
        );
      }
    } catch (err: any) {
      setMessage(err?.message || 'Failed to remove duplicate customers.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExportBackup() {
    if (!permissions.canEditOrders) return;
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
      setMessage('Backup downloaded (JSON + CSV files).');
    } catch (err: any) {
      setMessage(err?.message || 'Backup export failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAllCustomers() {
    if (!permissions.canEditOrders) return;
    if (customers.length === 0) {
      setMessage('No customers to delete.');
      return;
    }
    const ok = window.confirm(
      `Delete all ${customers.length} customers? This cannot be undone. Orders will keep their customer names but lose the customer link.`
    );
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const count = await deleteAllCustomers();
      setSelectedCustomerId(null);
      setMessage(`Removed ${count} customer${count === 1 ? '' : 's'}.`);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to delete customers.');
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

  async function handleConvertEstimateToOrder(doc: CustomerDocument) {
    if (!permissions.canEditOrders || !selectedCustomer) return;
    if (doc.type !== 'estimate') return;
    if (doc.orderId) {
      onOpenOrder?.(doc.orderId);
      return;
    }

    const ok = window.confirm(
      `Convert ${doc.documentNumber} into a plant order for ${selectedCustomer.name}? This adds it to Orders for pulling/loading. The estimate stays on the customer record.`
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
        notes: item.notes
      }));

      if (items.length === 0) {
        throw new Error('This estimate has no line items to convert.');
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

      setMessage(`Estimate converted to order. Opening it now…`);
      onOpenOrder?.(orderId);
    } catch (err: any) {
      setMessage(err?.message || 'Failed to convert estimate to order.');
    } finally {
      setConvertingDocId(null);
    }
  }

  return (
    <div className="space-y-6">
      {selectedCustomer ? (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-emerald-100 p-5">
            <button
              type="button"
              onClick={() => {
                setSelectedCustomerId(null);
                setMessage(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 hover:text-emerald-950 mb-3"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to customers
            </button>
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                <Users className="h-5 w-5 text-emerald-700" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900 truncate">{selectedCustomer.name}</h2>
                <p className="text-xs text-gray-500">
                  {[selectedCustomer.contactEmail, selectedCustomer.phone].filter(Boolean).join(' • ') ||
                    'No contact info'}
                </p>
              </div>
            </div>
            {message && (
              <p className="mt-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                {message}
              </p>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
            <div>
              {(selectedCustomer.pointOfContact ||
                selectedCustomer.shippingAddress ||
                selectedCustomer.receiverAddress) && (
                <p className="text-xs text-gray-600">
                  {selectedCustomer.pointOfContact ? `Point of Contact: ${selectedCustomer.pointOfContact}` : ''}
                  {selectedCustomer.pointOfContact &&
                  (selectedCustomer.shippingAddress || selectedCustomer.receiverAddress)
                    ? ' • '
                    : ''}
                  {selectedCustomer.shippingAddress || selectedCustomer.receiverAddress
                    ? `Ship-to: ${selectedCustomer.shippingAddress || selectedCustomer.receiverAddress}`
                    : ''}
                </p>
              )}
              {selectedCustomer.billingAddress && (
                <p className="text-xs text-gray-600 mt-1">Billing: {selectedCustomer.billingAddress}</p>
              )}
              {selectedCustomer.paymentTerms && (
                <p className="text-xs text-gray-600 mt-1">Terms: {selectedCustomer.paymentTerms}</p>
              )}
            </div>

            {permissions.canEditOrders && (
              <div className="border-t border-gray-100 pt-4 space-y-3">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">Edit customer</p>
                <div className="grid md:grid-cols-2 gap-3">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Customer name"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    placeholder="Email"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="Phone"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <input
                    value={editPointOfContact}
                    onChange={(e) => setEditPointOfContact(e.target.value)}
                    placeholder="Point of contact"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                    disabled={busy}
                  />
                  <textarea
                    rows={3}
                    value={editBillingAddress}
                    onChange={(e) => setEditBillingAddress(e.target.value)}
                    placeholder="Billing address"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
                    disabled={busy}
                  />
                  <textarea
                    rows={3}
                    value={editShippingAddress}
                    onChange={(e) => setEditShippingAddress(e.target.value)}
                    placeholder="Ship-to address"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
                    disabled={busy}
                  />
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
                    <option value="COD">COD</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                  {editPaymentTermsType === 'CUSTOM' && (
                    <input
                      value={editCustomPaymentTerms}
                      onChange={(e) => setEditCustomPaymentTerms(e.target.value)}
                      placeholder="Custom terms"
                      className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
                      disabled={busy}
                    />
                  )}
                  <input
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Notes"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleSaveSelectedCustomer}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 disabled:opacity-50"
                >
                  Save Customer Changes
                </button>
              </div>
            )}

            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
                Estimates & Invoices ({customerDocuments.length})
              </p>
              {customerDocuments.length === 0 ? (
                <p className="text-xs text-gray-500 mb-3">
                  No estimates or invoices yet. Create one after uploading an order, or from an open order.
                </p>
              ) : (
                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1 mb-3">
                  {customerDocuments.map((doc) => (
                    <div key={doc.id} className="border border-gray-100 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900 truncate">{doc.documentNumber}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(doc.documentDate).toLocaleDateString()} • ${doc.grandTotal.toFixed(2)}
                            {doc.orderNumber ? ` • Order #${doc.orderNumber}` : ''}
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase shrink-0 ${
                            doc.type === 'invoice'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-sky-100 text-sky-800'
                          }`}
                        >
                          {doc.type}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {permissions.canViewInvoices && onOpenDocument && (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.orderId || null, doc.type, doc)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800"
                          >
                            <DollarSign className="h-3.5 w-3.5" />
                            Open {doc.type}
                          </button>
                        )}
                        {permissions.canEditOrders && doc.type === 'estimate' && !doc.orderId && (
                          <button
                            type="button"
                            disabled={convertingDocId === doc.id || busy}
                            onClick={() => handleConvertEstimateToOrder(doc)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-sky-800 hover:text-sky-950 disabled:opacity-50"
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            {convertingDocId === doc.id ? 'Converting…' : 'Convert to order'}
                          </button>
                        )}
                        {doc.type === 'estimate' && doc.orderId && onOpenOrder && (
                          <button
                            type="button"
                            onClick={() => onOpenOrder(doc.orderId!)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-sky-800 hover:text-sky-950"
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            Open linked order
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
                Orders ({selectedCustomerOrders.length})
              </p>
              {selectedCustomerOrders.length === 0 ? (
                <p className="text-xs text-gray-500">No linked orders yet.</p>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                  {selectedCustomerOrders.map((order) => (
                    <div key={order.id} className="border border-gray-100 rounded-xl p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-gray-900 truncate">
                            Order #{order.orderNumber}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(order.dateCreated).toLocaleDateString()} • {order.items.length} items
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase ${
                            order.status === 'completed'
                              ? 'bg-emerald-100 text-emerald-800'
                              : order.status === 'loading'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {order.status}
                        </span>
                      </div>
                      {onOpenOrder && (
                        <button
                          type="button"
                          onClick={() => onOpenOrder(order.id)}
                          className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          Open order
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
          <div className="bg-white rounded-2xl border border-emerald-100 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <Users className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Customers Workspace</h2>
                  <p className="text-xs text-gray-500">Search customers, then open one to view details.</p>
                </div>
              </div>
              {permissions.canEditOrders && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm((open) => !open);
                    setMessage(null);
                  }}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800"
                >
                  {showAddForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {showAddForm ? 'Close' : 'Add Customer'}
                </button>
              )}
            </div>

            {permissions.canEditOrders && (
              <div className="flex flex-wrap gap-2 mb-4">
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs font-bold cursor-pointer hover:bg-emerald-100">
                  <Upload className="h-4 w-4" />
                  Upload Customer CSV
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
                  Export backup
                </button>
                {countDuplicateCustomerNames(customers) > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDeduplicateCustomers}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-xs font-bold hover:bg-amber-100 disabled:opacity-50"
                  >
                    Remove duplicates ({countDuplicateCustomerNames(customers)})
                  </button>
                )}
                {customers.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDeleteAllCustomers}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-50"
                  >
                    Delete all customers
                  </button>
                )}
              </div>
            )}

            {message && (
              <p className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 mb-4">
                {message}
              </p>
            )}

            {permissions.canEditOrders && showAddForm && (
              <form
                onSubmit={handleAddCustomer}
                className="border border-gray-200 rounded-2xl p-4 space-y-3 bg-slate-50/60 mb-4"
              >
                <h3 className="text-sm font-bold text-gray-900">New customer</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Customer name *"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Contact email"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Phone"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <input
                    value={pointOfContact}
                    onChange={(e) => setPointOfContact(e.target.value)}
                    placeholder="Point of contact"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                    disabled={busy}
                  />
                  <textarea
                    rows={3}
                    value={billingAddress}
                    onChange={(e) => setBillingAddress(e.target.value)}
                    placeholder="Billing address"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2 bg-white"
                    disabled={busy}
                  />
                  <textarea
                    rows={3}
                    value={shippingAddress}
                    onChange={(e) => setShippingAddress(e.target.value)}
                    placeholder="Ship-to address"
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2 bg-white"
                    disabled={busy}
                  />
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
                    <option value="COD">COD</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                  {paymentTermsType === 'CUSTOM' && (
                    <input
                      value={customPaymentTerms}
                      onChange={(e) => setCustomPaymentTerms(e.target.value)}
                      placeholder="Custom terms"
                      className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                      disabled={busy}
                    />
                  )}
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800 disabled:opacity-50"
                >
                  Save Customer
                </button>
              </form>
            )}

            <div className="relative mb-3">
              <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search for customer..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
              />
            </div>

            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-xs text-gray-500">No customers yet.</p>
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
                      className="w-full text-left border border-gray-100 rounded-xl p-3 transition hover:bg-emerald-50/50 hover:border-emerald-200"
                    >
                      <p className="text-sm font-bold text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-500">
                        {[c.contactEmail, c.phone].filter(Boolean).join(' • ') || 'No contact info'}
                      </p>
                      <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                        {rowOrders.length} order{rowOrders.length === 1 ? '' : 's'}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
