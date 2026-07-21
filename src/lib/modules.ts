import { Tenant, TenantModuleId } from '../types';
import { AppPermissions } from './permissions';

export type { TenantModuleId };

/** Paid / optional modules. Core (orders, trucks, team, weights, customers) is always on. */
export interface TenantModuleDef {
  id: TenantModuleId;
  label: string;
  description: string;
}

export const TENANT_MODULE_DEFS: TenantModuleDef[] = [
  {
    id: 'inventory',
    label: 'Inventory',
    description: 'Live plant inventory, uploads, and low-stock alerts.'
  },
  {
    id: 'invoicing',
    label: 'Invoicing',
    description: 'Estimates, invoices, and invoice save cues.'
  },
  {
    id: 'reports',
    label: 'Reports',
    description: 'Sales and operations reporting workspace.'
  },
  {
    id: 'tasks',
    label: 'Tasks',
    description: 'Weekly task board, assign, and checkoff.'
  },
  {
    id: 'bol',
    label: 'Bill of Lading',
    description: 'Generate BOL documents from truck loads.'
  },
  {
    id: 'vendors',
    label: 'Assign Vendor',
    description: 'Tag order lines with the grower/vendor you are buying from.'
  },
  {
    id: 'profit',
    label: 'Cost & Profit',
    description: 'Enter plant cost per line and see profit/margin on the order (internal only).'
  }
];

export const ALL_TENANT_MODULE_IDS: TenantModuleId[] = TENANT_MODULE_DEFS.map((m) => m.id);

/**
 * Opt-in modules stay off unless explicitly enabled for a nursery.
 * Not included in new-tenant defaults or legacy "all add-ons" grandfathering.
 */
export const OPT_IN_MODULE_IDS: TenantModuleId[] = ['vendors', 'profit'];

/** Standard package for new nurseries and legacy tenants (excludes opt-in modules). */
export const DEFAULT_NEW_TENANT_MODULES: TenantModuleId[] = ALL_TENANT_MODULE_IDS.filter(
  (id) => !OPT_IN_MODULE_IDS.includes(id)
);

/**
 * Resolve enabled add-on modules for a tenant.
 * Legacy tenants with no `modules` field get the standard package (opt-in modules stay off).
 */
export function resolveEnabledModules(
  tenant: Pick<Tenant, 'modules'> | null | undefined
): Set<TenantModuleId> {
  if (!tenant || tenant.modules == null) {
    return new Set(DEFAULT_NEW_TENANT_MODULES);
  }
  const valid = new Set<TenantModuleId>();
  for (const id of tenant.modules) {
    if ((ALL_TENANT_MODULE_IDS as string[]).includes(id)) {
      valid.add(id);
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
  const inventory = mods.has('inventory');
  const invoicing = mods.has('invoicing');
  const reports = mods.has('reports');
  const tasks = mods.has('tasks');
  const bol = mods.has('bol');
  const vendors = mods.has('vendors');
  const profit = mods.has('profit');

  return {
    ...permissions,
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
    canEditCost: permissions.canEditCost && profit
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
