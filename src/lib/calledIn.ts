import type { Tenant } from '../types';

/** Called-in checkoff is a Bayou State workflow. */
export function isBayouStateTenant(
  tenant: Pick<Tenant, 'id' | 'publicAvailabilitySlug'> | null | undefined
): boolean {
  const slug = String(tenant?.publicAvailabilitySlug || '')
    .trim()
    .toLowerCase();
  const id = String(tenant?.id || '')
    .trim()
    .toLowerCase();
  return slug === 'bayou-state-plant-co' || id.startsWith('bayou-state-plant-co');
}

/** On for Bayou State unless Team turns it off. Hidden for every other nursery. */
export function tenantCalledInEnabled(
  tenant: Pick<Tenant, 'id' | 'publicAvailabilitySlug' | 'calledInEnabled'> | null | undefined
): boolean {
  if (!isBayouStateTenant(tenant)) return false;
  return tenant?.calledInEnabled !== false;
}
