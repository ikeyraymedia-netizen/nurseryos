import type { Tenant } from '../types';

/** On only when the seller console has enabled it for this nursery. */
export function tenantCalledInEnabled(
  tenant: Pick<Tenant, 'calledInEnabled'> | null | undefined
): boolean {
  return tenant?.calledInEnabled === true;
}
