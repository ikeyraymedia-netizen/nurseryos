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
  canViewBOL: boolean;
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
  owner: 4,
  admin: 3,
  loader: 2,
  field: 1
};

const ASSIGNABLE_ROLES: Exclude<MemberRole, 'owner'>[] = ['admin', 'loader', 'field'];

export function getAssignableRoles(): Exclude<MemberRole, 'owner'>[] {
  return [...ASSIGNABLE_ROLES];
}

/** Normalize member/invite roles; always returns at least one role. */
export function normalizeMemberRoles(
  roleOrRoles: MemberRole | MemberRole[] | null | undefined,
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
    if ((['owner', 'admin', 'loader', 'field'] as string[]).includes(role) && !unique.includes(role)) {
      unique.push(role);
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
        canViewBOL: true,
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
        canViewBOL: false,
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
    case 'field':
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
        canViewBOL: false,
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
    case 'loader':
      return 'Loader';
    case 'field':
      return 'Field';
    default:
      return role;
  }
}

export function rolesLabel(roles: MemberRole[]): string {
  return normalizeMemberRoles(roles).map(roleLabel).join(' · ');
}
