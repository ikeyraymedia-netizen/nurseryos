import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Users, Search, FileText } from 'lucide-react';
import { Customer, CustomerOrder } from '../types';
import { addCustomer, bulkImportCustomers, deleteAllCustomers, parseCsvCustomers, updateCustomer } from '../lib/customers';
import { AppPermissions } from '../lib/permissions';

interface CustomersWorkspaceProps {
  customers: Customer[];
  orders: CustomerOrder[];
  permissions: AppPermissions;
  onOpenOrder?: (orderId: string) => void;
}

export function CustomersWorkspace({ customers, orders, permissions, onOpenOrder }: CustomersWorkspaceProps) {
  const NET_TERM_OPTIONS = ['NET 10', 'NET 15', 'NET 30', 'NET 45', 'NET 60', 'NET 90'] as const;
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

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

  const detailPanelRef = useRef<HTMLDivElement | null>(null);

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
    if (!selectedCustomerId) return;
    detailPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedCustomerId]);

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

  useEffect(() => {
    if (selectedCustomerId) return;
    if (filtered.length === 0) return;
    setSelectedCustomerId(filtered[0].id);
  }, [filtered, selectedCustomerId]);

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
      await addCustomer({
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
      setMessage(`Imported ${count} customers.`);
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

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-emerald-100 p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center">
            <Users className="h-5 w-5 text-emerald-700" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Customers Workspace</h2>
            <p className="text-xs text-gray-500">Upload or add customers, then assign orders to them.</p>
          </div>
        </div>

        {permissions.canEditOrders && (
          <div className="flex flex-wrap gap-2 mb-4">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold cursor-pointer hover:bg-emerald-800">
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
          <p className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
            {message}
          </p>
        )}
      </div>

      {permissions.canEditOrders && (
        <form onSubmit={handleAddCustomer} className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <h3 className="text-sm font-bold text-gray-900">Add Customer</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Customer name *"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Contact email"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
            <input
              value={pointOfContact}
              onChange={(e) => setPointOfContact(e.target.value)}
              placeholder="Point of contact"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              disabled={busy}
            />
            <textarea
              rows={3}
              value={billingAddress}
              onChange={(e) => setBillingAddress(e.target.value)}
              placeholder="Billing address"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
              disabled={busy}
            />
            <textarea
              rows={3}
              value={shippingAddress}
              onChange={(e) => setShippingAddress(e.target.value)}
              placeholder="Ship-to address"
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm md:col-span-2"
              disabled={busy}
            />
            <select
              value={paymentTermsType}
              onChange={(e) => setPaymentTermsType(e.target.value)}
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
            {paymentTermsType === 'CUSTOM' && (
              <input
                value={customPaymentTerms}
                onChange={(e) => setCustomPaymentTerms(e.target.value)}
                placeholder="Custom terms"
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
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

      <div className="grid md:grid-cols-2 gap-5">
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <div className="relative mb-3">
            <Search className="h-4 w-4 absolute left-3 top-2.5 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers..."
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm"
            />
          </div>
          <div className="space-y-2 max-h-[420px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-500">No customers yet.</p>
            ) : (
              filtered.map((c) => {
                const isActive = selectedCustomerId === c.id;
                const rowOrders = ordersByCustomerId.get(c.id) || [];
                return (
                  <div key={c.id} className="border border-gray-100 rounded-xl">
                    <button
                      type="button"
                      onClick={() => setSelectedCustomerId((prev) => (prev === c.id ? null : c.id))}
                      className={`w-full text-left rounded-xl p-3 transition cursor-pointer ${
                        isActive
                          ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200'
                          : 'hover:bg-gray-50'
                      }`}
                      aria-pressed={isActive}
                    >
                      <p className="text-sm font-bold text-gray-900">
                        {isActive ? 'Selected: ' : ''}
                        {c.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {[c.contactEmail, c.phone].filter(Boolean).join(' • ') || 'No contact info'}
                      </p>
                      {(c.pointOfContact || c.receiverAddress) && (
                        <p className="text-[11px] text-gray-600 mt-1">
                          {c.pointOfContact ? `POC: ${c.pointOfContact}` : ''}
                          {c.pointOfContact && (c.shippingAddress || c.receiverAddress) ? ' • ' : ''}
                          {c.shippingAddress || c.receiverAddress ? `Ship: ${c.shippingAddress || c.receiverAddress}` : ''}
                        </p>
                      )}
                      {c.paymentTerms && (
                        <p className="text-[11px] text-gray-600 mt-1">Terms: {c.paymentTerms}</p>
                      )}
                      <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                        {rowOrders.length} order{rowOrders.length === 1 ? '' : 's'}
                      </p>
                    </button>

                    {isActive && (
                      <div className="px-3 pb-3 border-t border-emerald-100 bg-emerald-50/40 rounded-b-xl">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mt-2 mb-2">
                          Orders
                        </p>
                        {rowOrders.length === 0 ? (
                          <p className="text-xs text-gray-500">No linked orders yet.</p>
                        ) : (
                          <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                            {rowOrders.map((order) => (
                              <div key={order.id} className="border border-gray-100 rounded-lg p-2 bg-white">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-xs font-bold text-gray-900 truncate">Order #{order.orderNumber}</p>
                                    <p className="text-[11px] text-gray-500">
                                      {new Date(order.dateCreated).toLocaleDateString()} • {order.items.length} items
                                    </p>
                                  </div>
                                  <span
                                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase ${
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
                                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800"
                                  >
                                    <FileText className="h-3 w-3" />
                                    Open order
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div ref={detailPanelRef} className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-emerald-700 mb-3">
            {selectedCustomer ? `Selected customer: ${selectedCustomer.name}` : 'No customer selected'}
          </p>
          {!selectedCustomer ? (
            <p className="text-xs text-gray-500">Select a customer to view all past and current orders.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900">{selectedCustomer.name}</h3>
                <p className="text-xs text-gray-500">
                  {[selectedCustomer.contactEmail, selectedCustomer.phone].filter(Boolean).join(' • ') || 'No contact info'}
                </p>
                {(selectedCustomer.pointOfContact || selectedCustomer.receiverAddress) && (
                  <p className="text-xs text-gray-600 mt-1">
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
                <div className="border-t border-gray-100 pt-3 space-y-3">
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

              <div className="border-t border-gray-100 pt-3">
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
                            <p className="text-sm font-bold text-gray-900 truncate">Order #{order.orderNumber}</p>
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
          )}
        </div>
      </div>
    </div>
  );
}
