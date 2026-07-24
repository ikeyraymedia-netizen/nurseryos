/** Persist workspace tab/order/truck across refresh and AuthGate remounts. */

export type WorkspaceTab =
  | 'orders'
  | 'trucks'
  | 'inventory'
  | 'customers'
  | 'reports'
  | 'tasks';

export const WORKSPACE_TABS: WorkspaceTab[] = [
  'orders',
  'trucks',
  'inventory',
  'customers',
  'reports',
  'tasks'
];

const WORKSPACE_URL_STORAGE_KEY = 'nurseryos:workspaceUrl';

export type WorkspaceUrlState = {
  tab: WorkspaceTab;
  order: string | null;
  truck: string | null;
};

export function isWorkspaceTab(raw: string | null | undefined): raw is WorkspaceTab {
  return !!raw && (WORKSPACE_TABS as string[]).includes(raw);
}

export function readStoredWorkspaceUrl(): Partial<WorkspaceUrlState> | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_URL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceUrlState>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredWorkspaceUrl(state: WorkspaceUrlState) {
  try {
    sessionStorage.setItem(WORKSPACE_URL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Read tab from URL first, then sessionStorage. No permission gating. */
export function readPersistedWorkspaceTab(): WorkspaceTab | null {
  const fromUrl = new URLSearchParams(window.location.search).get('tab');
  if (isWorkspaceTab(fromUrl)) return fromUrl;
  const stored = readStoredWorkspaceUrl()?.tab;
  return isWorkspaceTab(stored) ? stored : null;
}

export function readPersistedOrderId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('order');
  if (fromUrl) return fromUrl;
  return readStoredWorkspaceUrl()?.order || null;
}

export function readPersistedTruckId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('truck');
  if (fromUrl) return fromUrl;
  return readStoredWorkspaceUrl()?.truck || null;
}

export function syncWorkspaceUrl(state: WorkspaceUrlState) {
  writeStoredWorkspaceUrl(state);

  const url = new URL(window.location.href);
  url.searchParams.set('tab', state.tab);
  if (state.order) url.searchParams.set('order', state.order);
  else url.searchParams.delete('order');
  if (state.truck) url.searchParams.set('truck', state.truck);
  else url.searchParams.delete('truck');

  const next = url.pathname + url.search + url.hash;
  const current =
    window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) {
    window.history.replaceState({}, '', next);
  }
}

/**
 * Run before React mounts. Ensures:
 * - URL `tab` is mirrored into sessionStorage
 * - If URL has no tab but sessionStorage does, URL is restored immediately
 *   (so AuthGate remounts / loading spinners never lose the tab)
 */
export function bootstrapWorkspaceUrl() {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  const urlTab = url.searchParams.get('tab');
  const urlOrder = url.searchParams.get('order');
  const urlTruck = url.searchParams.get('truck');
  const stored = readStoredWorkspaceUrl();

  if (isWorkspaceTab(urlTab)) {
    writeStoredWorkspaceUrl({
      tab: urlTab,
      order: urlOrder || stored?.order || null,
      truck: urlTruck || stored?.truck || null
    });
    return;
  }

  if (stored && isWorkspaceTab(stored.tab)) {
    syncWorkspaceUrl({
      tab: stored.tab,
      order: stored.order || null,
      truck: stored.truck || null
    });
  }
}
