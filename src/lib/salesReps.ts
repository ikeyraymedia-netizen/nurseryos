import { useEffect, useState } from 'react';
import { TenantMember } from '../types';
import { memberHasRole } from './permissions';
import { listTeamMembers } from './tenants';

/** Label shown in Sales Rep dropdowns (orders / invoices). */
export function memberSalesRepLabel(member: TenantMember): string {
  const name = member.displayName?.trim();
  if (name) return name;
  const email = member.email?.trim() || '';
  const local = email.split('@')[0]?.trim();
  return local || email || member.userId;
}

/** Members in this nursery who have the Sales role. */
export function salesRepLabelsFromMembers(members: TenantMember[]): string[] {
  const labels = members
    .filter((m) => memberHasRole(m, 'sales'))
    .map(memberSalesRepLabel)
    .filter(Boolean);
  return Array.from(new Set(labels)).sort((a, b) => a.localeCompare(b));
}

/** Load Sales-role display names for the active nursery. */
export function useSalesRepOptions(tenantId: string | undefined | null): string[] {
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!tenantId) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    listTeamMembers(tenantId)
      .then((members) => {
        if (!cancelled) setOptions(salesRepLabelsFromMembers(members));
      })
      .catch((err) => {
        console.warn('Failed to load sales reps:', err);
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return options;
}
