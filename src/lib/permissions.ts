import { MemberRole, TenantMember } from '../types';

export interface AppPermissions {
  canViewOrders: boolean;
  canViewTrucks: boolean;
  canCheckOffLoading: boolean;
  canEditOrders: boolean;
  canDeleteOrders: boolean;
  canBuildTrucks: boolean;
  canEditTrucks: boolean;
  canDeleteTrucks: boolean;
  canUploadOrders: boolean;
  canViewInvoices: boolean;
  canViewPricing: boolean;
  canViewCustomers: boolean;
  canEditCustomers: boolean;
  canViewBOL: boolean;
  /** Assign / view grower vendors on order lines (gated by vendors module). */
  canUseVendors: boolean;
  /** Enter plant cost and view profit/margin (gated by profit module; internal only). */
  canViewProfit: boolean;
  /** Enter/edit plant cost on the order workspace (gated by profit module). */
  canEditCost: boolean;
  /** Connect / disconnect Stripe for the nursery (gated by payments module). */
  canManageStripe: boolean;
  /** Create invoice payment links via Stripe Connect (gated by payments + invoicing). */
  canCollectPayments: boolean;
  canEditWeights: boolean;
  canViewInventory: boolean;
  canEditInventory: boolean;
  canUploadInventory: boolean;
  canManageTeam: boolean;
  canViewReports: boolean;
  canViewTasks: boolean;
  canAssignTasks: boolean;
  canCompleteTasks: boolean;
}

const ROLE_RANK: Record<MemberRole, number> = {
  owner: 5,
  admin: 4,
  supervisor: 3,
  office: 3,
  loader: 2,
  inventory: 1
};

const ALL_ROLES: MemberRole[] = [
  'owner',
  'admin',
  'supervisor',
  'office',
  'loader',
  'inventory'
];

const ASSIGNABLE_ROLES: Exclude<MemberRole, 'owner'>[] = [
  'admin',
  'supervisor',
  'office',
  'loader',
  'inventory'
];

/** Map legacy role ids stored in Firestore to current ids. */
function canonicalizeRole(role: string): MemberRole | null {
  if (role === 'field') return 'inventory';
  if ((ALL_ROLES as string[]).includes(role)) return role as MemberRole;
  return null;
}

export function getAssignableRoles(): Exclude<MemberRole, 'owner'>[] {
  return [...ASSIGNABLE_ROLES];
}

/** Normalize member/invite roles; always returns at least one role. */
export function normalizeMemberRoles(
  roleOrRoles: MemberRole | MemberRole[] | string | string[] | null | undefined,
  fallbackRole?: MemberRole
): MemberRole[] {
  const raw = Array.isArray(roleOrRoles)
    ? roleOrRoles
    : roleOrRoles
      ? [roleOrRoles]
      : fallbackRole
        ? [fallbackRole]
        : [];
  const unique: MemberRole[] = [];
  for (const role of raw) {
    const canonical = canonicalizeRole(String(role));
    if (canonical && !unique.includes(canonical)) {
      unique.push(canonical);
    }
  }
  if (unique.length === 0) return ['loader'];
  return unique.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
}

export function getMemberRoles(member: Pick<TenantMember, 'role' | 'roles'>): MemberRole[] {
  return normalizeMemberRoles(member.roles?.length ? member.roles : member.role, member.role);
}

export function memberHasRole(
  member: Pick<TenantMember, 'role' | 'roles'>,
  role: MemberRole
): boolean {
  return getMemberRoles(member).includes(role);
}

export function primaryRole(roles: MemberRole[]): MemberRole {
  const normalized = normalizeMemberRoles(roles);
  return normalized[0] || 'loader';
}

export function getPermissionsForRole(role: MemberRole): AppPermissions {
  switch (role) {
    case 'owner':
    case 'admin':
      return {
        canViewOrders: true,
        canViewTrucks: true,
        canCheckOffLoading: true,
        canEditOrders: true,
        canDeleteOrders: true,
        canBuildTrucks: true,
        canEditTrucks: true,
        canDeleteTrucks: true,
        canUploadOrders: true,
        canViewInvoices: true,
        canViewPricing: true,
        canViewCustomers: true,
        canEditCustomers: true,
        canViewBOL: true,
        canUseVendors: true,
        canViewProfit: true,
        canEditCost: true,
        canManageStripe: true,
        canCollectPayments: true,
        canEditWeights: true,
        canViewInventory: true,
        canEditInventory: true,
        canUploadInventory: true,
        canManageTeam: true,
        canViewReports: true,
        canViewTasks: true,
        canAssignTasks: true,
        canCompleteTasks: true
      };
    case 'supervisor':
      // Yard lead: full ops visibility + edit truck order lines / loading, BOL print.
      // No pricing, invoices, customers, uploads, deletes, or team/billing admin.
      return {
        canViewOrders: true,
        canViewTrucks: true,
        canCheckOffLoading: true,
        canEditOrders: true,
        canDeleteOrders: false,
        canBuildTrucks: true,
        canEditTrucks: true,
        canDeleteTrucks: false,
        canUploadOrders: false,
        canViewInvoices: false,
        canViewPricing: false,
        canViewCustomers: false,
        canEditCustomers: false,
        canViewBOL: true,
        canUseVendors: true,
        canViewProfit: false,
        canEditCost: true,
        canManageStripe: false,
        canCollectPayments: false,
        canEditWeights: false,
        canViewInventory: true,
        canEditInventory: true,
        canUploadInventory: true,
        canManageTeam: false,
        canViewReports: false,
        canViewTasks: true,
        canAssignTasks: true,
        canCompleteTasks: true
      };
    case 'office':
      // Front office: customers, invoices, pricing, reports. No yard/ops tabs.
      return {
        canViewOrders: false,
        canViewTrucks: false,
        canCheckOffLoading: false,
        canEditOrders: false,
        canDeleteOrders: false,
        canBuildTrucks: false,
        canEditTrucks: false,
        canDeleteTrucks: false,
        canUploadOrders: false,
        canViewInvoices: true,
        canViewPricing: true,
        canViewCustomers: true,
        canEditCustomers: true,
        canViewBOL: false,
        canUseVendors: false,
        canViewProfit: true,
        canEditCost: true,
        canManageStripe: false,
        canCollectPayments: true,
        canEditWeights: false,
        canViewInventory: false,
        canEditInventory: false,
        canUploadInventory: false,
        canManageTeam: false,
        canViewReports: true,
        canViewTasks: false,
        canAssignTasks: false,
        canCompleteTasks: false
      };
    case 'loader':
      return {
        canViewOrders: true,
        canViewTrucks: true,
        canCheckOffLoading: true,
        canEditOrders: false,
        canDeleteOrders: false,
        canBuildTrucks: false,
        canEditTrucks: false,
        canDeleteTrucks: false,
        canUploadOrders: false,
        canViewInvoices: false,
        canViewPricing: false,
        canViewCustomers: false,
        canEditCustomers: false,
        canViewBOL: false,
        canUseVendors: true,
        canViewProfit: false,
        canEditCost: false,
        canManageStripe: false,
        canCollectPayments: false,
        canEditWeights: false,
        canViewInventory: false,
        canEditInventory: false,
        canUploadInventory: false,
        canManageTeam: false,
        canViewReports: false,
        canViewTasks: true,
        canAssignTasks: false,
        canCompleteTasks: true
      };
    case 'inventory':
      return {
        canViewOrders: false,
        canViewTrucks: false,
        canCheckOffLoading: false,
        canEditOrders: false,
        canDeleteOrders: false,
        canBuildTrucks: false,
        canEditTrucks: false,
        canDeleteTrucks: false,
        canUploadOrders: false,
        canViewInvoices: false,
        canViewPricing: false,
        canViewCustomers: false,
        canEditCustomers: false,
        canViewBOL: false,
        canUseVendors: false,
        canViewProfit: false,
        canEditCost: false,
        canManageStripe: false,
        canCollectPayments: false,
        canEditWeights: false,
        canViewInventory: true,
        canEditInventory: true,
        canUploadInventory: true,
        canManageTeam: false,
        canViewReports: false,
        canViewTasks: true,
        canAssignTasks: false,
        canCompleteTasks: true
      };
    default:
      return getPermissionsForRole('loader');
  }
}

/** OR-merge permissions so multi-role users get access from every role. */
export function getPermissionsForRoles(roles: MemberRole[]): AppPermissions {
  const list = normalizeMemberRoles(roles);
  return list.slice(1).reduce((merged, role) => {
    const next = getPermissionsForRole(role);
    const out = { ...merged };
    (Object.keys(next) as (keyof AppPermissions)[]).forEach((key) => {
      out[key] = Boolean(merged[key] || next[key]);
    });
    return out;
  }, getPermissionsForRole(list[0]));
}

export function getPermissionsForMember(
  member: Pick<TenantMember, 'role' | 'roles'>
): AppPermissions {
  return getPermissionsForRoles(getMemberRoles(member));
}

export function roleLabel(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'supervisor':
      return 'Supervisor';
    case 'office':
      return 'Office';
    case 'loader':
      return 'Loader';
    case 'inventory':
      return 'Inventory';
    default:
      return role;
  }
}

export function rolesLabel(roles: MemberRole[]): string {
  return normalizeMemberRoles(roles).map(roleLabel).join(' · ');
}
