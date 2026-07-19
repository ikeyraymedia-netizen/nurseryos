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
  }
];

export const ALL_TENANT_MODULE_IDS: TenantModuleId[] = TENANT_MODULE_DEFS.map((m) => m.id);

/** New nurseries get the full package (matches prior all-features experience). */
export const DEFAULT_NEW_TENANT_MODULES: TenantModuleId[] = [...ALL_TENANT_MODULE_IDS];

/**
 * Resolve enabled add-on modules for a tenant.
 * Legacy tenants with no `modules` field keep everything enabled (grandfathered).
 */
export function resolveEnabledModules(
  tenant: Pick<Tenant, 'modules'> | null | undefined
): Set<TenantModuleId> {
  if (!tenant || tenant.modules == null) {
    return new Set(ALL_TENANT_MODULE_IDS);
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
    canViewBOL: permissions.canViewBOL && bol
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
