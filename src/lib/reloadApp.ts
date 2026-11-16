/** Drop a stale home-screen copy and load the latest NurseryOS. */
export async function reloadAppForUpdates(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // ignore
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map((reg) => {
          const scriptUrl =
            reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
          if (scriptUrl.includes('firebase-messaging-sw')) return Promise.resolve(false);
          return reg.unregister();
        })
      );
    }
  } catch {
    // ignore
  }
  window.location.reload();
}
