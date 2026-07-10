import { MemberRole } from '../types';

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
        canManageTeam: true
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
        canManageTeam: false
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
        canManageTeam: false
      };
    default:
      return getPermissionsForRole('loader');
  }
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
