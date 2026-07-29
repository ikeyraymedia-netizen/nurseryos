import { getMemberRoles, normalizeMemberRoles } from '../permissions';
import type { MemberRole, TenantMember } from '../types';
import { useT } from './context';

export function useRoleLabel() {
  const t = useT();
  return {
    roleLabel: (role: MemberRole) => t(`roles.${role}`),
    rolesLabel: (roles: MemberRole[]) =>
      normalizeMemberRoles(roles)
        .map((role) => t(`roles.${role}`))
        .join(' · ')
  };
}

export function useMemberRolesLabel() {
  const { rolesLabel } = useRoleLabel();
  return (member: Pick<TenantMember, 'role' | 'roles'>) => rolesLabel(getMemberRoles(member));
}
