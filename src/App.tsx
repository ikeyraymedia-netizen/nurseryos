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
import { InvoiceModal } from './components/InvoiceModal';
import {
  subscribeToOrders,
  subscribeToWeights,
  subscribeToTrucks,
  initializeDefaultWeightsIfNeeded
} from './lib/db';
import { subscribeToCustomers } from './lib/customers';
import { getPermissionsForRole } from './lib/permissions';
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
import { Upload, Truck as TruckIcon, FileText, Plus, Sprout, ArrowLeft, BarChart3, Users } from 'lucide-react';

type WorkspaceTab = 'orders' | 'trucks' | 'inventory' | 'customers' | 'reports';

function NurseryApp({
  tenant,
  member,
  userEmail,
  userId,
  onSignOut
}: {
  tenant: Tenant;
  member: TenantMember;
  userEmail: string;
  userId: string;
  onSignOut: () => Promise<void>;
}) {
  const permissions = useMemo(() => getPermissionsForRole(member.role), [member.role]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [trucks, setTrucks] = useState<TruckType[]>([]);
  const [containerWeights, setContainerWeights] = useState<ContainerWeight[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedTruckId, setSelectedTruckId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(
    permissions.canViewInventory && !permissions.canViewOrders ? 'inventory' : 'orders'
  );
  const [isEditingTruck, setIsEditingTruck] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showTeamManager, setShowTeamManager] = useState(false);
  const [showWeightsEditor, setShowWeightsEditor] = useState(false);
  const [documentModal, setDocumentModal] = useState<{
    orderId: string | null;
    type: CustomerDocumentType;
    existingDocument?: CustomerDocument | null;
  } | null>(null);
  const [focusCustomerId, setFocusCustomerId] = useState<string | null>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!permissions.canViewOrders && !permissions.canViewTrucks) {
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

        if (permissions.canEditWeights || permissions.canUploadOrders) {
          unsubscribeWeights = subscribeToWeights((weights) => {
            if (active) setContainerWeights(weights);
          });
        }

        if (permissions.canViewTrucks) {
          unsubscribeTrucks = subscribeToTrucks((newTrucks) => {
            if (active) setTrucks(newTrucks);
          });
        }

        if (permissions.canViewOrders) {
          unsubscribeOrders = subscribeToOrders((newOrders) => {
            if (!active) return;
            clearTimeout(safetyTimeout);
            setOrders(newOrders);
            setLoading(false);
            setSelectedOrderId((prev) => {
              if (prev) return prev;
              if (selectedTruckId) return null;
              return newOrders.length > 0 ? newOrders[0].id : null;
            });
          });
          unsubscribeCustomers = subscribeToCustomers((nextCustomers) => {
            if (active) setCustomers(nextCustomers);
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
            role={member.role}
            onSignOut={onSignOut}
          />
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <InventoryWorkspace permissions={permissions} />
          </main>
        </div>
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
        role={member.role}
        onSignOut={onSignOut}
        onManageTeam={permissions.canManageTeam ? () => setShowTeamManager(true) : undefined}
        onManageWeights={permissions.canEditWeights ? () => setShowWeightsEditor(true) : undefined}
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
            {permissions.canViewOrders && (
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
          </div>

          {activeTab === 'inventory' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Use the main panel to manage live plant inventory.
            </div>
          ) : activeTab === 'customers' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Manage your customer directory in the main panel.
            </div>
          ) : activeTab === 'reports' ? (
            <div className="text-xs text-gray-500 bg-white rounded-xl border border-gray-150 p-4">
              Ask AI for loading, inventory, sales, and customer reports in the main panel.
            </div>
          ) : activeTab === 'orders' ? (
            <OrdersList
              orders={dynamicOrders}
              selectedOrderId={selectedOrderId}
              canDelete={permissions.canDeleteOrders}
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
            <InventoryWorkspace permissions={permissions} />
          ) : activeTab === 'customers' ? (
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
              containerWeights={containerWeights}
              customers={customers}
              permissions={permissions}
              nurseryName={tenant.name}
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
          nurseryName={tenant.name}
        />
      )}

      {showTeamManager && (
        <TeamManager
          tenant={tenant}
          currentUserId={userId}
          onClose={() => setShowTeamManager(false)}
        />
      )}

      {showWeightsEditor && (
        <WeightsEditor
          containerWeights={containerWeights}
          onClose={() => setShowWeightsEditor(false)}
        />
      )}
    </div>
    </InventoryMatchProvider>
  );
}

export default function App() {
  return (
    <AuthGate>
      {({ user, tenant, member, onSignOut }) => (
        <NurseryApp
          tenant={tenant}
          member={member}
          userEmail={user.email || 'unknown'}
          userId={user.uid}
          onSignOut={onSignOut}
        />
      )}
    </AuthGate>
  );
}
