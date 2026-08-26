const LOAD_ALERTS_KEY = 'nurseryos:inventory:loadAlertsEnabled';

/** When false, skip window.alert popups on load/pull inventory shortfalls. Default: on. */
export function areInventoryLoadAlertsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(LOAD_ALERTS_KEY);
    if (raw === null) return true;
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
}

export function setInventoryLoadAlertsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LOAD_ALERTS_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

export function subscribeInventoryLoadAlerts(
  listener: (enabled: boolean) => void
): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === LOAD_ALERTS_KEY) {
      listener(areInventoryLoadAlertsEnabled());
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
