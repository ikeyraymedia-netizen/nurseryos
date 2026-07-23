import { useState, useEffect, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { OrdersList } from './components/OrdersList';
import { TrucksList } from './components/TrucksList';
import { BrandLogo } from './components/BrandLogo';
import { TruckBuilder } from './components/TruckBuilder';
import { TruckWorkspace } from './components/TruckWorkspace';
import { OrderUploader } from './components/OrderUploader';
import { LoaderWorkspace } from './components/LoaderWorkspace';
import { WeightsEditor } from './components/WeightsEditor';
import { AuthGate } from './components/AuthGate';
import { InventoryWorkspace } from './components/InventoryWorkspace';
import { InventoryMatchProvider } from './components/InventoryMatchProvider';
import { TeamManager } from './components/TeamManager';
import { CustomersWorkspace } from './components/CustomersWorkspace';
import { ReportsWorkspace } from './components/ReportsWorkspace';
import { TasksWorkspace } from './components/TasksWorkspace';
import { WhatsNewModal } from './components/WhatsNewModal';
import { InvoiceModal } from './components/InvoiceModal';
import {
  subscribeToOrders,
  subscribeToWeights,
  subscribeToTrucks,
  initializeDefaultWeightsIfNeeded
} from './lib/db';
import { subscribeToCustomers } from './lib/customers';
import { getPermissionsForMember } from './lib/permissions';
import { applyModuleGates, tenantHasAnyWorkspace } from './lib/modules';
import { listAllDocuments } from './lib/documents';
import { buildOrdersNeedingInvoiceSet } from './lib/invoicing';
import {
  buildWhatsNewDigest,
  getLastSeenAt,
  listTasksCreatedSinceForTenant,
  setLastSeenAt,
  WhatsNewItem
} from './lib/whatsNew';
import { PlatformDashboard } from './components/PlatformDashboard';
import { resolveNurseryShippingAddress } from './lib/tenants';
import { resolveNurseryLogoSrc } from './lib/nurseryBranding';
import {
  CustomerOrder,
  ContainerWeight,
  Truck as TruckType,
  Tenant,
  TenantMember,
  Customer,
  CustomerDocumentType,
  CustomerDocument
} from './types';
import { Upload, Truck as TruckIcon, FileText, Plus, Sprout, ArrowLeft, BarChart3, Users, ClipboardList } from 'lucide-react';

type WorkspaceTab = 'orders' | 'trucks' | 'inventory' | 'customers' | 'reports' | 'tasks';

function useWhatsNewDigest(params: {
  tenantId: string;
  userId: string;
  orders: CustomerOrder[];
  trucks: TruckType[];
  ready: boolean;
  canViewOrders: boolean;
  canViewTrucks: boolean;
  canViewTasks: boolean;
}) {
  const [items, setItems] = useState<WhatsNewItem[]>([]);
  const ranRef = useRef(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!params.ready || ranRef.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || ranRef.current) return;
      ranRef.current = true;

      void (async () => {
        const p = paramsRef.current;
        const lastSeen = getLastSeenAt(p.tenantId, p.userId);
        if (!lastSeen) {
          setLastSeenAt(p.tenantId, p.userId);
          return;
        }

        const tasks = p.canViewTasks
          ? await listTasksCreatedSinceForTenant(p.tenantId, lastSeen)
          : [];
        if (cancelled) return;

        const digest = buildWhatsNewDigest({
          orders: p.canViewOrders ? p.orders : [],
          trucks: p.canViewTrucks ? p.trucks : [],
          tasks,
          since: lastSeen,
          userId: p.userId
        });
        if (digest.length > 0) setItems(digest);
        else setLastSeenAt(p.tenantId, p.userId);
      })().catch((err) => console.warn('Whats-new digest failed:', err));
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [params.ready]);

  function dismiss() {
    setLastSeenAt(params.tenantId, params.userId);
    setItems([]);
  }

  return { items, dismiss };
}

function NurseryApp({
  tenant: tenantProp,
  member,
  userEmail,
  userId,
  isPlatformAdmin = false,
  onSignOut,
  onRefreshTenant,
  onBackToSeller
}: {
  tenant: Tenant;
  member: TenantMember;
  userEmail: string;
  userId: string;
  isPlatformAdmin?: boolean;
  onSignOut: () => Promise<void>;
  onRefreshTenant?: () => Promise<void>;
  onBackToSeller?: () => void;
}) {
  const [tenant, setTenant] = useState(tenantProp);
  const [memberState, setMemberState] = useState(member);
  const nurseryAddress = resolveNurseryShippingAddress(tenant);
  const nurseryLogoSrc = resolveNurseryLogoSrc(tenant);
  useEffect(() => {
    setTenant(tenantProp);
  }, [tenantProp]);
  useEffect(() => {
    setMemberState(member);
  }, [member]);

  const permissions = useMemo(
    () => applyModuleGates(getPermissionsForMember(memberState), tenant),
    [memberState, tenant]
  );
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [trucks, setTrucks] = useState<TruckType[]>([]);
  const [containerWeights, setContainerWeights] = useState<ContainerWeight[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedTruckId, setSelectedTruckId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => {
    if (permissions.canViewOrders) return 'orders';
    if (permissions.canViewCustomers) return 'customers';
    if (permissions.canViewReports) return 'reports';
    if (permissions.canViewInventory) return 'inventory';
    if (permissions.canViewTrucks) return 'trucks';
    if (permissions.canViewTasks) return 'tasks';
    return 'orders';
  });
  const [isEditingTruck, setIsEditingTruck] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showTeamManager, setShowTeamManager] = useState(false);
  const [showWeightsEditor, setShowWeightsEditor] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qb = params.get('qb');
    const stripe = params.get('stripe');
    const stripePay = params.get('stripe_pay');
    if (!qb && !stripe && !stripePay) return;

    if (qb === 'connected') {
      alert(
        'QuickBooks connected. Open Team to confirm status, then push invoices from the invoice screen.'
      );
      setShowTeamManager(true);
    } else if (qb === 'error') {
      alert(`QuickBooks connect failed: ${params.get('message') || 'Unknown error'}`);
    }

    if (stripe === 'return' || stripe === 'refresh') {
      alert(
        stripe === 'return'
          ? 'Stripe onboarding returned. Open Team to confirm charges are enabled, then create a pay link from an invoice.'
          : 'Stripe onboarding was refreshed. Open Team and continue Connect if needed.'
      );
      setShowTeamManager(true);
    }

    if (stripePay === 'success') {
      alert('Payment submitted. The invoice will show as paid once Stripe confirms (usually seconds).');
    } else if (stripePay === 'cancel') {
      alert('Payment canceled. You can create a new pay link from the invoice when ready.');
    }

    const url = new URL(window.location.href);
    url.searchParams.delete('qb');
    url.searchParams.delete('message');
    url.searchParams.delete('stripe');
    url.searchParams.delete('stripe_pay');
    url.searchParams.delete('documentId');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  const [documentModal, setDocumentModal] = useState<{
    orderId: string | null;
    type: CustomerDocumentType;
    existingDocument?: CustomerDocument | null;
  } | null>(null);
  const [focusCustomerId, setFocusCustomerId] = useState<string | null>(null);
  const [orderIdsNeedingInvoice, setOrderIdsNeedingInvoice] = useState<Set<string>>(
    () => new Set()
  );
  const mainPanelRef = useRef<HTMLDivElement>(null);

  const whatsNewReady =
    !loading ||
    (!permissions.canViewOrders &&
      !permissions.canViewTrucks &&
      !permissions.canViewCustomers &&
      !permissions.canViewReports);
  const { items: whatsNewItems, dismiss: dismissWhatsNew } = useWhatsNewDigest({
    tenantId: tenant.id,
    userId,
    orders,
    trucks,
    ready: whatsNewReady,
    canViewOrders: permissions.canViewOrders,
    canViewTrucks: permissions.canViewTrucks,
    canViewTasks: permissions.canViewTasks
  });

  useEffect(() => {
    if (!permissions.canViewInvoices || !permissions.canViewOrders) {
      setOrderIdsNeedingInvoice(new Set());
      return;
    }
    let cancelled = false;
    listAllDocuments()
      .then((docs) => {
        if (!cancelled) setOrderIdsNeedingInvoice(buildOrdersNeedingInvoiceSet(orders, docs));
      })
      .catch(() => {
        if (!cancelled) setOrderIdsNeedingInvoice(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [orders, permissions.canViewInvoices, permissions.canViewOrders, documentModal]);

  useEffect(() => {
    if (activeTab === 'customers' && !permissions.canViewCustomers) {
      setActiveTab(
        permissions.canViewOrders
          ? 'orders'
          : permissions.canViewReports
            ? 'reports'
            : permissions.canViewInventory
              ? 'inventory'
              : 'trucks'
      );
    }
  }, [activeTab, permissions.canViewCustomers, permissions.canViewOrders, permissions.canViewReports, permissions.canViewInventory]);

  useEffect(() => {
    const needsOpsData =
      permissions.canViewOrders ||
      permissions.canViewTrucks ||
      permissions.canViewReports ||
      permissions.canViewCustomers;
    if (!needsOpsData && !permissions.canViewInventory) {
      setLoading(false);
      return;
    }

    let active = true;
    let unsubscribeWeights: (() => void) | null = null;
    let unsubscribeOrders: (() => void) | null = null;
    let unsubscribeTrucks: (() => void) | null = null;
    let unsubscribeCustomers: (() => void) | null = null;

    async function init() {
      const safetyTimeout = setTimeout(() => {
        if (active && loading) setLoading(false);
      }, 5000);

      try {
        if (permissions.canEditWeights || permissions.canUploadOrders) {
          await initializeDefaultWeightsIfNeeded();
        }
        if (!active) return;

        // Supervisors/loaders need weights for truck capacity even without edit/upload rights.
        if (
          permissions.canEditWeights ||
          permissions.canUploadOrders ||
          permissions.canViewTrucks ||
          permissions.canViewOrders
        ) {
          unsubscribeWeights = subscribeToWeights((weights) => {
            if (active) setContainerWeights(weights);
          });
        }

        // Reports (office) needs truck/order snapshots without yard tabs.
        if (permissions.canViewTrucks || permissions.canViewReports) {
          unsubscribeTrucks = subscribeToTrucks((newTrucks) => {
            if (active) setTrucks(newTrucks);
          });
        }

        if (permissions.canViewCustomers) {
          unsubscribeCustomers = subscribeToCustomers((nextCustomers) => {
            if (active) setCustomers(nextCustomers);
          });
        }

        if (permissions.canViewOrders || permissions.canViewReports) {
          unsubscribeOrders = subscribeToOrders((newOrders) => {
            if (!active) return;
            clearTimeout(safetyTimeout);
            setOrders(newOrders);
            setLoading(false);
            if (permissions.canViewOrders) {
              setSelectedOrderId((prev) => {
                if (prev) return prev;
                if (selectedTruckId) return null;
                return newOrders.length > 0 ? newOrders[0].id : null;
              });
            }
          });
        } else {
          clearTimeout(safetyTimeout);
          setLoading(false);
        }
      } catch (err) {
        console.error('Database connection init failed:', err);
        clearTimeout(safetyTimeout);
        if (active) setLoading(false);
      }
    }

    init();

    return () => {
      active = false;
      if (unsubscribeWeights) unsubscribeWeights();
      if (unsubscribeOrders) unsubscribeOrders();
      if (unsubscribeTrucks) unsubscribeTrucks();
      if (unsubscribeCustomers) unsubscribeCustomers();
    };
  }, [tenant.id, permissions]);

  const dynamicOrders = orders.map((order) => {
    const computedWeight = order.items.reduce((total, item) => {
      const match = containerWeights.find(
        (w) =>
          w.id.toLowerCase() === item.containerSize.toLowerCase() ||
          w.label.toLowerCase() === item.containerSize.toLowerCase()
      );
      return total + (match ? match.weightLbs : 0) * item.quantity;
    }, 0);
    return { ...order, totalWeightLbs: computedWeight };
  });

  const selectedOrder = dynamicOrders.find((o) => o.id === selectedOrderId);
  const documentModalOrder = useMemo(() => {
    if (!documentModal) return null;
    if (documentModal.orderId) {
      return dynamicOrders.find((o) => o.id === documentModal.orderId) || null;
    }
    const doc = documentModal.existingDocument;
    if (!doc) return null;
    // Synthetic order so estimate-only documents can open in InvoiceModal
    return {
      id: `preview-${doc.id}`,
      customerName: doc.customerName,
      customerId: doc.customerId,
      orderNumber: doc.orderNumber || doc.documentNumber,
      items: (doc.items || []).map((item) => ({
        id: item.id,
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: item.quantity,
        loadedQuantity: 0,
        unitPrice: item.unitPrice,
        notes: item.notes
      })),
      originalText: '',
      dateCreated: doc.createdAt,
      status: 'pending' as const,
      totalWeightLbs: 0,
      customerEmail: doc.customerEmail,
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
    } satisfies CustomerOrder;
  }, [documentModal, dynamicOrders]);
  const documentModalCustomer = documentModalOrder
    ? customers.find((c) => c.id === documentModalOrder.customerId) ||
      customers.find(
        (c) =>
          c.name.trim().toLowerCase() === documentModalOrder.customerName.trim().toLowerCase()
      ) ||
      null
    : null;
  const activeTruck = trucks.find((t) => t.id === selectedTruckId);

  const isBuildingTruck = selectedTruckId === 'new' || isEditingTruck;
  const showingTruckPanel =
    isBuildingTruck || (!!selectedTruckId && !!activeTruck);
  const showingOrderPanel = !!selectedOrder && activeTab === 'orders' && !isBuildingTruck;
  const hideLeftSidebar =
    isBuildingTruck || (activeTab === 'trucks' && showingTruckPanel) || showingOrderPanel;

  function leaveTruckBuilderIfNeeded(): boolean {
    if (!isBuildingTruck) return true;
    return window.confirm('Leave truck builder? Your changes will be lost.');
  }

  function startBuildTruck() {
    setActiveTab('trucks');
    setSelectedOrderId(null);
    setSelectedTruckId('new');
    setIsEditingTruck(false);
  }

  useEffect(() => {
    if (hideLeftSidebar) {
      mainPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [hideLeftSidebar, selectedTruckId, selectedOrderId, isEditingTruck]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <BrandLogo variant="icon" size="lg" showText={false} nurseryName={tenant.name} />
        <p className="text-sm font-bold text-gray-800 uppercase tracking-wider mt-6">Loading workspace...</p>
      </div>
    );
  }

  if (!tenantHasAnyWorkspace(tenant)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <Header
          orders={[]}
          nurseryName={tenant.name}
          userEmail={userEmail}
          role={memberState.role}
          member={memberState}
          onSignOut={onSignOut}
          onManageTeam={
            permissions.canManageTeam ? () => setShowTeamManager(true) : undefined
          }
          onBackToSeller={onBackToSeller}
        />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-amber-200 bg-white shadow-sm p-6 text-center">
            <div className="flex justify-center">
              <BrandLogo variant="icon" size="lg" showText={false} nurseryName={tenant.name} />
            </div>
            <h2 className="mt-4 text-lg font-black text-gray-900">Workspace not activated yet</h2>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              <span className="font-bold text-gray-900">{tenant.name}</span> is registered, but no
              workspaces have been turned on. NurseryOS will enable Orders, Trucks, Customers, and
              other modules from the seller console.
            </p>
            <p className="mt-3 text-xs text-gray-500">
              Team stays available from the header. Workspace tabs appear after activation.
            </p>
          </div>
        </div>
        {showTeamManager && (
          <TeamManager
            tenant={tenant}
            currentUserId={userId}
            onClose={() => setShowTeamManager(false)}
            onMemberUpdated={setMemberState}
          />
        )}
      </div>
    );
  }

  if (permissions.canViewInventory && !permissions.canViewOrders && !permissions.canViewTrucks) {
    return (
      <InventoryMatchProvider
        containerWeights={containerWeights}
        permissions={permissions}
      >
        <div className="min-h-screen bg-slate-100/90 flex flex-col">
          <Header
            orders={[]}
            nurseryName={tenant.name}
            userEmail={userEmail}
            role={memberState.role}
            member={memberState}
            onSignOut={onSignOut}
            onManageTeam={permissions.canManageTeam ? () => setShowTeamManager(true) : undefined}
            onManagePackages={undefined}
            onBackToSeller={onBackToSeller}
          />
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
            <div className="flex bg-slate-200/80 p-1.5 rounded-2xl gap-1 border border-slate-300/70 shadow-inner max-w-md">
              <button
                type="button"
                onClick={() => setActiveTab('inventory')}
                className={`flex-1 flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'inventory' || activeTab === 'orders'
                    ? 'bg-emerald-700 text-white shadow-sm'
                    : 'text-gray-500'
                }`}
              >
                <Sprout className="h-4 w-4" />
                <span>Inventory</span>
              </button>
              {permissions.canViewTasks && (
                <button
                  type="button"
                  onClick={() => setActiveTab('tasks')}
                  className={`flex-1 flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                    activeTab === 'tasks' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                  }`}
                >
                  <ClipboardList className="h-4 w-4" />
                  <span>Tasks</span>
                </button>
              )}
            </div>
            {activeTab === 'tasks' ? (
              <TasksWorkspace
                tenant={tenant}
                member={memberState}
                userId={userId}
                permissions={permissions}
              />
            ) : (
              <InventoryWorkspace
                permissions={permissions}
                trucks={trucks}
                orders={dynamicOrders}
              />
            )}
          </main>
        </div>
        {whatsNewItems.length > 0 && (
          <WhatsNewModal
            items={whatsNewItems}
            onDismiss={dismissWhatsNew}
            onOpenTasks={() => setActiveTab('tasks')}
          />
        )}
        {showTeamManager && (
          <TeamManager
            tenant={tenant}
            currentUserId={userId}
            onClose={() => setShowTeamManager(false)}
            onMemberUpdated={setMemberState}
          />
        )}
      </InventoryMatchProvider>
    );
  }

  return (
    <InventoryMatchProvider
      containerWeights={containerWeights}
      permissions={permissions}
    >
    <div className="min-h-screen bg-slate-100/90 flex flex-col font-sans text-gray-900">
      <Header
        orders={dynamicOrders}
        nurseryName={tenant.name}
        userEmail={userEmail}
        role={memberState.role}
        member={memberState}
        onSignOut={onSignOut}
        onManageTeam={permissions.canManageTeam ? () => setShowTeamManager(true) : undefined}
        onManageWeights={permissions.canEditWeights ? () => setShowWeightsEditor(true) : undefined}
        onManagePackages={undefined}
        onBackToSeller={onBackToSeller}
        onSelectOrder={(id) => {
          setSelectedOrderId(id);
          setSelectedTruckId(null);
          setIsEditingTruck(false);
          setActiveTab('orders');
        }}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col lg:flex-row gap-6">
        <div className={`w-full lg:w-80 shrink-0 flex-col ${hideLeftSidebar ? 'hidden' : 'flex'}`}>
          <div className="flex bg-slate-200/80 p-1.5 rounded-2xl mb-4 gap-1 border border-slate-300/70 shadow-inner flex-wrap">
            {permissions.canViewOrders && (
              <button
                onClick={() => {
                  if (!leaveTruckBuilderIfNeeded()) return;
                  setActiveTab('orders');
                  setSelectedTruckId(null);
                  setIsEditingTruck(false);
                }}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'orders' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <FileText className="h-4 w-4" />
                <span>Orders ({dynamicOrders.length})</span>
              </button>
            )}
            {permissions.canViewTrucks && (
              <button
                onClick={() => {
                  setActiveTab('trucks');
                  setSelectedOrderId(null);
                }}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'trucks' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <TruckIcon className="h-4 w-4" />
                <span>Trucks ({trucks.length})</span>
              </button>
            )}
            {permissions.canViewInventory && (
              <button
                onClick={() => setActiveTab('inventory')}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'inventory' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <Sprout className="h-4 w-4" />
                <span>Inventory</span>
              </button>
            )}
            {permissions.canViewCustomers && (
              <button
                onClick={() => setActiveTab('customers')}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'customers' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <Users className="h-4 w-4" />
                <span>Customers</span>
              </button>
            )}
            {permissions.canViewReports && (
              <button
                onClick={() => {
                  if (!leaveTruckBuilderIfNeeded()) return;
                  setActiveTab('reports');
                  setSelectedTruckId(null);
                  setSelectedOrderId(null);
                  setIsEditingTruck(false);
                }}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'reports' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <BarChart3 className="h-4 w-4" />
                <span>Reports</span>
              </button>
            )}
            {permissions.canViewTasks && (
              <button
                onClick={() => {
                  if (!leaveTruckBuilderIfNeeded()) return;
                  setActiveTab('tasks');
                  setSelectedTruckId(null);
                  setSelectedOrderId(null);
                  setIsEditingTruck(false);
                }}
                className={`flex-1 min-w-[100px] flex items-center justify-center space-x-1.5 py-2.5 text-xs font-bold rounded-xl transition-all ${
                  activeTab === 'tasks' ? 'bg-emerald-700 text-white shadow-sm' : 'text-gray-500'
                }`}
              >
                <ClipboardList className="h-4 w-4" />
                <span>Tasks</span>
              </button>
            )}
          </div>

          {activeTab === 'inventory' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Use the main panel to manage live plant inventory.
            </div>
          ) : activeTab === 'customers' && permissions.canViewCustomers ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Manage your customer directory in the main panel.
            </div>
          ) : activeTab === 'reports' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Ask AI for loading, inventory, sales, and customer reports in the main panel.
            </div>
          ) : activeTab === 'tasks' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Assign weekly tasks by person. Workers check them off when finished.
            </div>
          ) : activeTab === 'orders' ? (
            <OrdersList
              orders={dynamicOrders}
              selectedOrderId={selectedOrderId}
              canDelete={permissions.canDeleteOrders}
              orderIdsNeedingInvoice={orderIdsNeedingInvoice}
              onSelectOrder={(id) => {
                setSelectedOrderId(id);
                setSelectedTruckId(null);
                setIsEditingTruck(false);
              }}
            />
          ) : (
            <TrucksList
              trucks={trucks}
              orders={dynamicOrders}
              selectedTruckId={selectedTruckId}
              canDelete={permissions.canDeleteTrucks}
              canCreate={permissions.canBuildTrucks}
              onStartBuild={startBuildTruck}
              onSelectTruck={(id) => {
                if (!leaveTruckBuilderIfNeeded()) return;
                setActiveTab('trucks');
                setSelectedTruckId(id);
                setSelectedOrderId(null);
                setIsEditingTruck(false);
              }}
            />
          )}
        </div>

        <div ref={mainPanelRef} className="flex-1 min-w-0">
          {hideLeftSidebar && (
            <button
              type="button"
              onClick={() => {
                if (isBuildingTruck) {
                  setSelectedTruckId(null);
                  setIsEditingTruck(false);
                  return;
                }
                setSelectedTruckId(null);
                setSelectedOrderId(null);
                setIsEditingTruck(false);
              }}
              className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 bg-white border border-emerald-200 rounded-xl px-3 py-2 shadow-sm"
            >
              <ArrowLeft className="h-4 w-4" />
              {isBuildingTruck ? 'Back to trucks' : 'Back to list'}
            </button>
          )}
          {activeTab === 'inventory' ? (
            <InventoryWorkspace
              permissions={permissions}
              trucks={trucks}
              orders={dynamicOrders}
            />
          ) : activeTab === 'customers' && permissions.canViewCustomers ? (
            <CustomersWorkspace
              customers={customers}
              orders={dynamicOrders}
              trucks={trucks}
              permissions={permissions}
              nurseryName={tenant.name}
              containerWeights={containerWeights}
              initialSelectedCustomerId={focusCustomerId}
              onOpenOrder={(orderId) => {
                setSelectedOrderId(orderId);
                setSelectedTruckId(null);
                setIsEditingTruck(false);
                setActiveTab('orders');
              }}
              onOpenDocument={(orderId, type, existingDocument) => {
                setDocumentModal({ orderId, type, existingDocument });
              }}
            />
          ) : activeTab === 'reports' ? (
            <ReportsWorkspace
              orders={dynamicOrders}
              trucks={trucks}
              customers={customers}
              permissions={permissions}
              nurseryName={tenant.name}
            />
          ) : activeTab === 'tasks' ? (
            <TasksWorkspace
              tenant={tenant}
              member={memberState}
              userId={userId}
              permissions={permissions}
            />
          ) : selectedTruckId === 'new' && permissions.canBuildTrucks ? (
            <TruckBuilder
              orders={dynamicOrders}
              onCancel={() => {
                setSelectedTruckId(null);
                setIsEditingTruck(false);
              }}
              onSuccess={(id) => {
                setSelectedTruckId(id);
                setActiveTab('trucks');
                setIsEditingTruck(false);
              }}
            />
          ) : isEditingTruck && activeTruck && permissions.canEditTrucks ? (
            <TruckBuilder
              truckToEdit={activeTruck}
              orders={dynamicOrders}
              onCancel={() => setIsEditingTruck(false)}
              onSuccess={() => {
                setIsEditingTruck(false);
                setActiveTab('trucks');
              }}
            />
          ) : selectedTruckId && activeTruck ? (
            <TruckWorkspace
              truck={activeTruck}
              orders={dynamicOrders}
              containerWeights={containerWeights}
              permissions={permissions}
              customers={customers}
              nurseryName={tenant.name}
              nurseryAddress={nurseryAddress}
              nurseryLogoSrc={nurseryLogoSrc}
              tenantId={tenant.id}
              onEditTruck={() => {
                setActiveTab('trucks');
                setIsEditingTruck(true);
              }}
              onSelectOrder={(orderId) => {
                if (!leaveTruckBuilderIfNeeded()) return;
                setSelectedOrderId(orderId);
                setSelectedTruckId(null);
                setIsEditingTruck(false);
                setActiveTab('orders');
              }}
            />
          ) : selectedOrder ? (
            <LoaderWorkspace
              order={selectedOrder}
              orders={dynamicOrders}
              containerWeights={containerWeights}
              customers={customers}
              permissions={permissions}
              nurseryName={tenant.name}
              nurseryAddress={nurseryAddress}
              tenantId={tenant.id}
            />
          ) : (
            <div className="bg-white rounded-2xl border border-emerald-100 p-12 text-center min-h-[400px] flex flex-col items-center justify-center">
              <TruckIcon className="h-10 w-10 text-emerald-800 mb-4" />
              <h3 className="text-lg font-bold">No Selection</h3>
              <p className="text-sm text-gray-500 max-w-sm mt-1">
                {permissions.canCheckOffLoading
                  ? 'Select a truck or order on the left to start loading.'
                  : 'Select an item on the left.'}
              </p>
            </div>
          )}
        </div>

        {permissions.canUploadOrders &&
          activeTab !== 'inventory' &&
          activeTab !== 'customers' &&
          activeTab !== 'reports' &&
          activeTab !== 'tasks' &&
          !isBuildingTruck && (
          <div className="w-full lg:w-80 shrink-0 flex flex-col gap-6">
            <OrderUploader
              containerWeights={containerWeights}
              customers={customers}
              tenantId={tenant.id}
              permissions={permissions}
              onUploadSuccess={(newOrderId) => {
                setSelectedOrderId(newOrderId);
                setSelectedTruckId(null);
                setIsEditingTruck(false);
                setActiveTab('orders');
              }}
              onCreateDocument={(orderId, type) => {
                setDocumentModal({ orderId, type });
              }}
              onEstimateSaved={(customerId) => {
                setFocusCustomerId(customerId);
                setActiveTab('customers');
              }}
            />
          </div>
        )}
      </main>

      {permissions.canViewInvoices && documentModalOrder && documentModal && (
        <InvoiceModal
          isOpen
          onClose={() => setDocumentModal(null)}
          order={documentModalOrder}
          documentType={documentModal.type}
          customer={documentModalCustomer}
          existingDocument={documentModal.existingDocument || null}
          truckOrders={
            documentModalOrder.truckId
              ? dynamicOrders.filter(
                  (candidate) => candidate.truckId === documentModalOrder.truckId
                )
              : []
          }
          nurseryName={tenant.name}
          nurseryAddress={nurseryAddress}
          tenantId={tenant.id}
          canViewProfit={permissions.canViewProfit}
          canCollectPayments={permissions.canCollectPayments}
        />
      )}

      {showTeamManager && (
        <TeamManager
          tenant={tenant}
          currentUserId={userId}
          onClose={() => setShowTeamManager(false)}
          onMemberUpdated={setMemberState}
        />
      )}

      {showWeightsEditor && (
        <WeightsEditor
          containerWeights={containerWeights}
          onClose={() => setShowWeightsEditor(false)}
        />
      )}

      {whatsNewItems.length > 0 && (
        <WhatsNewModal
          items={whatsNewItems}
          onDismiss={dismissWhatsNew}
          onOpenOrders={() => {
            setActiveTab('orders');
            setSelectedTruckId(null);
            setIsEditingTruck(false);
          }}
          onOpenTrucks={() => {
            setActiveTab('trucks');
            setSelectedOrderId(null);
            setIsEditingTruck(false);
          }}
          onOpenTasks={() => {
            setActiveTab('tasks');
            setSelectedTruckId(null);
            setSelectedOrderId(null);
            setIsEditingTruck(false);
          }}
        />
      )}
    </div>
    </InventoryMatchProvider>
  );
}

export default function App() {
  return (
    <AuthGate>
      {(session) => <RootApp session={session} />}
    </AuthGate>
  );
}

const SELLER_VIEW_KEY = 'nurseryos:sellerView';

function RootApp({
  session
}: {
  session: {
    user: { uid: string; email: string | null };
    profile: { isPlatformAdmin?: boolean; activeTenantId: string | null };
    tenant: Tenant | null;
    member: TenantMember | null;
    onSignOut: () => Promise<void>;
    onRefreshTenant: () => Promise<void>;
  };
}) {
  const isPlatformAdmin = !!session.profile.isPlatformAdmin;
  const [sellerView, setSellerView] = useState<'platform' | 'nursery'>(() => {
    if (!isPlatformAdmin) return 'nursery';
    try {
      const stored = sessionStorage.getItem(SELLER_VIEW_KEY);
      if (stored === 'nursery' || stored === 'platform') return stored;
    } catch {
      /* ignore */
    }
    return 'platform';
  });

  function goPlatform() {
    setSellerView('platform');
    try {
      sessionStorage.setItem(SELLER_VIEW_KEY, 'platform');
    } catch {
      /* ignore */
    }
  }

  function goNursery() {
    setSellerView('nursery');
    try {
      sessionStorage.setItem(SELLER_VIEW_KEY, 'nursery');
    } catch {
      /* ignore */
    }
  }

  if (isPlatformAdmin && sellerView === 'platform') {
    return (
      <PlatformDashboard
        userEmail={session.user.email || 'seller'}
        homeNursery={session.tenant}
        canOpenHomeNursery={!!session.tenant && !!session.member}
        onOpenHomeNursery={goNursery}
        onSignOut={session.onSignOut}
      />
    );
  }

  if (!session.tenant || !session.member) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center">
        <BrandLogo variant="icon" size="lg" showText={false} />
        <h1 className="mt-6 text-lg font-black">No nursery workspace linked</h1>
        <p className="mt-2 text-sm text-slate-400 max-w-md leading-relaxed">
          Your seller account can manage packages from the platform console. To open a nursery
          workspace (like Bayou), this account also needs to be a member of that nursery.
        </p>
        {isPlatformAdmin && (
          <button
            type="button"
            onClick={goPlatform}
            className="mt-6 px-4 py-2 rounded-xl bg-emerald-600 text-xs font-black"
          >
            Back to Seller console
          </button>
        )}
        <button
          type="button"
          onClick={() => session.onSignOut()}
          className="mt-3 text-xs font-bold text-slate-400 underline"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <NurseryApp
      tenant={session.tenant}
      member={session.member}
      userEmail={session.user.email || 'unknown'}
      userId={session.user.uid}
      isPlatformAdmin={isPlatformAdmin}
      onSignOut={session.onSignOut}
      onRefreshTenant={session.onRefreshTenant}
      onBackToSeller={isPlatformAdmin ? goPlatform : undefined}
    />
  );
}
