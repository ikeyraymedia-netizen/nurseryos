import { Tenant, TenantModuleId } from '../types';
import { AppPermissions } from './permissions';

export type { TenantModuleId };

/** Workspace / feature modules controlled from the seller console. */
export interface TenantModuleDef {
  id: TenantModuleId;
  label: string;
  description: string;
  /** Shown first in seller console as primary workspaces. */
  group?: 'workspace' | 'addon';
}

export const TENANT_MODULE_DEFS: TenantModuleDef[] = [
  {
    id: 'orders',
    label: 'Orders',
    description: 'Upload, edit, and load customer plant orders.',
    group: 'workspace'
  },
  {
    id: 'trucks',
    label: 'Trucks',
    description: 'Build trucks, loading checkoff, and pull sheets.',
    group: 'workspace'
  },
  {
    id: 'customers',
    label: 'Customers',
    description: 'Customer records, bill-to / ship-to, and document history.',
    group: 'workspace'
  },
  {
    id: 'inventory',
    label: 'Inventory',
    description: 'Live plant inventory, uploads, and low-stock alerts.',
    group: 'addon'
  },
  {
    id: 'invoicing',
    label: 'Invoicing',
    description: 'Estimates, invoices, and invoice save cues.',
    group: 'addon'
  },
  {
    id: 'reports',
    label: 'Reports',
    description: 'Sales and operations reporting workspace.',
    group: 'addon'
  },
  {
    id: 'tasks',
    label: 'Tasks',
    description: 'Weekly task board, assign, and checkoff.',
    group: 'addon'
  },
  {
    id: 'bol',
    label: 'Bill of Lading',
    description: 'Generate BOL documents from truck loads.',
    group: 'addon'
  },
  {
    id: 'vendors',
    label: 'Assign Vendor',
    description: 'Tag order lines with the grower/vendor you are buying from.',
    group: 'addon'
  },
  {
    id: 'profit',
    label: 'Cost & Profit',
    description: 'Enter plant cost per line and see profit/margin on the order (internal only).',
    group: 'addon'
  },
  {
    id: 'payments',
    label: 'Stripe Payments',
    description: 'Collect invoice payments via Stripe Connect (card checkout pay links).',
    group: 'addon'
  }
];

export const ALL_TENANT_MODULE_IDS: TenantModuleId[] = TENANT_MODULE_DEFS.map((m) => m.id);

/**
 * Opt-in modules stay off unless explicitly enabled for a nursery.
 * Not included in legacy grandfathering.
 */
export const OPT_IN_MODULE_IDS: TenantModuleId[] = ['vendors', 'profit', 'payments'];

/**
 * New nurseries start with nothing enabled — you turn workspaces on in the
 * seller console after they register.
 */
export const DEFAULT_NEW_TENANT_MODULES: TenantModuleId[] = [];

/**
 * Legacy tenants with no `modules` field keep their previous entitlement:
 * core workspaces + standard add-ons (vendors/profit stay off).
 */
export const LEGACY_TENANT_MODULES: TenantModuleId[] = ALL_TENANT_MODULE_IDS.filter(
  (id) => !OPT_IN_MODULE_IDS.includes(id)
);

/**
 * Resolve enabled modules for a tenant.
 * - `modules` omitted/undefined → legacy package (grandfathered)
 * - `modules: []` → nothing enabled (new signups)
 * - otherwise → listed modules
 *
 * Older saved packages never included orders/trucks/customers (those were always
 * on). If a non-empty list has none of those, keep core workspaces enabled so
 * existing nurseries are not locked out.
 */
export function resolveEnabledModules(
  tenant: Pick<Tenant, 'modules'> | null | undefined
): Set<TenantModuleId> {
  if (!tenant || tenant.modules == null) {
    return new Set(LEGACY_TENANT_MODULES);
  }
  const valid = new Set<TenantModuleId>();
  for (const id of tenant.modules) {
    if ((ALL_TENANT_MODULE_IDS as string[]).includes(id)) {
      valid.add(id);
    }
  }
  if (valid.size > 0) {
    const hasCore =
      valid.has('orders') || valid.has('trucks') || valid.has('customers');
    if (!hasCore) {
      valid.add('orders');
      valid.add('trucks');
      valid.add('customers');
    }
  }
  return valid;
}

export function tenantHasModule(
  tenant: Pick<Tenant, 'modules'> | null | undefined,
  moduleId: TenantModuleId
): boolean {
  return resolveEnabledModules(tenant).has(moduleId);
}

/** AND role permissions with tenant package entitlements. */
export function applyModuleGates(
  permissions: AppPermissions,
  tenant: Pick<Tenant, 'modules'> | null | undefined
): AppPermissions {
  const mods = resolveEnabledModules(tenant);
  const orders = mods.has('orders');
  const trucks = mods.has('trucks');
  const customers = mods.has('customers');
  const inventory = mods.has('inventory');
  const invoicing = mods.has('invoicing');
  const reports = mods.has('reports');
  const tasks = mods.has('tasks');
  const bol = mods.has('bol');
  const vendors = mods.has('vendors');
  const profit = mods.has('profit');
  const payments = mods.has('payments');
  const ops = orders || trucks;

  return {
    ...permissions,
    canViewOrders: permissions.canViewOrders && orders,
    canEditOrders: permissions.canEditOrders && orders,
    canDeleteOrders: permissions.canDeleteOrders && orders,
    canUploadOrders: permissions.canUploadOrders && orders,
    canViewTrucks: permissions.canViewTrucks && trucks,
    canBuildTrucks: permissions.canBuildTrucks && trucks,
    canEditTrucks: permissions.canEditTrucks && trucks,
    canDeleteTrucks: permissions.canDeleteTrucks && trucks,
    canCheckOffLoading: permissions.canCheckOffLoading && ops,
    canEditWeights: permissions.canEditWeights && ops,
    canViewCustomers: permissions.canViewCustomers && customers,
    canEditCustomers: permissions.canEditCustomers && customers,
    canViewInventory: permissions.canViewInventory && inventory,
    canEditInventory: permissions.canEditInventory && inventory,
    canUploadInventory: permissions.canUploadInventory && inventory,
    canViewInvoices: permissions.canViewInvoices && invoicing,
    canViewPricing: permissions.canViewPricing && invoicing,
    canViewReports: permissions.canViewReports && reports,
    canViewTasks: permissions.canViewTasks && tasks,
    canAssignTasks: permissions.canAssignTasks && tasks,
    canCompleteTasks: permissions.canCompleteTasks && tasks,
    canViewBOL: permissions.canViewBOL && bol,
    canUseVendors: permissions.canUseVendors && vendors,
    // Profit needs both the module AND invoicing (cost/margin lives in the invoice view).
    canViewProfit: permissions.canViewProfit && profit && invoicing,
    // Cost entry on the order workspace only needs the profit module.
    canEditCost: permissions.canEditCost && profit,
    canManageStripe: permissions.canManageStripe && payments,
    canCollectPayments: permissions.canCollectPayments && payments && invoicing
  };
}

export function normalizeModulesList(modules: string[]): TenantModuleId[] {
  const out: TenantModuleId[] = [];
  const seen = new Set<string>();
  for (const id of modules) {
    if ((ALL_TENANT_MODULE_IDS as string[]).includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as TenantModuleId);
    }
  }
  return out;
}

/** True when the nursery has at least one workspace/feature module on. */
export function tenantHasAnyWorkspace(
  tenant: Pick<Tenant, 'modules'> | null | undefined
): boolean {
  return resolveEnabledModules(tenant).size > 0;
}
