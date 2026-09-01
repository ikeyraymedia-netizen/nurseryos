import { getMessaging, getToken, isSupported, onMessage, Messaging } from 'firebase/messaging';
import { app } from '../firebase';
import { authJsonHeaders } from './apiAuth';

export type PushEventType =
  | 'invoice_paid'
  | 'order_uploaded'
  | 'truck_built'
  | 'truck_loading_started'
  | 'truck_loading_finished'
  | 'task_assigned'
  | 'plant_added';

const DEVICE_ID_KEY = 'nurseryos:fcmDeviceId';
const ENABLED_KEY = 'nurseryos:pushEnabled';

let messagingInstance: Messaging | null = null;
let foregroundListenerAttached = false;
let cachedVapidKey: string | null | undefined;

function bakedVapidKey(): string | null {
  const key = import.meta.env.VITE_FIREBASE_VAPID_KEY?.trim();
  return key || null;
}

/** Resolve the public VAPID key (build-time env or /api/push/config at runtime). */
export async function resolveVapidKey(): Promise<string | null> {
  const baked = bakedVapidKey();
  if (baked) return baked;
  if (cachedVapidKey !== undefined) return cachedVapidKey;
  try {
    const res = await fetch('/api/push/config');
    if (!res.ok) {
      cachedVapidKey = null;
      return null;
    }
    const data = (await res.json()) as { vapidKey?: string | null };
    cachedVapidKey = data.vapidKey?.trim() || null;
  } catch {
    cachedVapidKey = null;
  }
  return cachedVapidKey;
}

export function isPushConfigured(): boolean {
  if (bakedVapidKey()) return true;
  if (cachedVapidKey !== undefined) return Boolean(cachedVapidKey);
  return false;
}

export async function loadPushConfig(): Promise<boolean> {
  const key = await resolveVapidKey();
  return Boolean(key);
}

export function isPushEnabledLocally(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function setPushEnabledLocally(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // ignore
  }
}

function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'default';
  }
}

async function getMessagingInstance(): Promise<Messaging | null> {
  if (messagingInstance) return messagingInstance;
  if (!(await isSupported())) return null;
  messagingInstance = getMessaging(app);
  return messagingInstance;
}

function attachForegroundListener(messaging: Messaging): void {
  if (foregroundListenerAttached) return;
  foregroundListenerAttached = true;
  onMessage(messaging, (payload) => {
    const title = payload.notification?.title || payload.data?.title || 'NurseryOS';
    const body = payload.notification?.body || payload.data?.body || '';
    const tag = payload.data?.dedupeKey || payload.data?.type || 'nurseryos-alert';
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(title, {
        body,
        icon: '/favicon.png',
        tag,
        data: payload.data
      });
      n.onclick = () => {
        const url = payload.data?.url || '/';
        window.focus();
        window.location.href = url;
      };
    }
  });
}

async function registerTokenWithServer(token: string): Promise<void> {
  const headers = await authJsonHeaders();
  const res = await fetch('/api/push/register-token', {
    method: 'POST',
    headers,
    body: JSON.stringify({ token, deviceId: getOrCreateDeviceId() })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to register push token.');
  }
}

async function unregisterTokenWithServer(): Promise<void> {
  const headers = await authJsonHeaders();
  await fetch('/api/push/unregister-token', {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId: getOrCreateDeviceId() })
  });
}

export async function enablePushNotifications(): Promise<'granted' | 'denied' | 'unsupported'> {
  const vapidKey = await resolveVapidKey();
  if (!vapidKey) return 'unsupported';
  if (!(await isSupported())) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setPushEnabledLocally(false);
    return 'denied';
  }

  const messaging = await getMessagingInstance();
  if (!messaging) return 'unsupported';

  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
    scope: '/'
  });
  await navigator.serviceWorker.ready;

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration
  });
  if (!token) {
    setPushEnabledLocally(false);
    return 'denied';
  }

  await registerTokenWithServer(token);
  attachForegroundListener(messaging);
  setPushEnabledLocally(true);
  return 'granted';
}

export async function disablePushNotifications(): Promise<void> {
  try {
    await unregisterTokenWithServer();
  } catch {
    // ignore
  }
  setPushEnabledLocally(false);
}

/** Re-register silently when permission was already granted. */
export async function initPushNotifications(): Promise<void> {
  if (!isPushEnabledLocally()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!(await resolveVapidKey())) return;
  try {
    await enablePushNotifications();
  } catch (err) {
    console.warn('[push] init failed', err);
  }
}

export async function notifyPushEvent(params: {
  tenantId: string;
  type: PushEventType;
  title: string;
  body: string;
  url?: string;
  targetUserId?: string;
}): Promise<void> {
  try {
    const headers = await authJsonHeaders();
    await fetch('/api/push/event', {
      method: 'POST',
      headers,
      body: JSON.stringify(params)
    });
  } catch (err) {
    console.warn('[push] notify failed', err);
  }
}

export function pushPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function sendTestPushNotification(tenantId: string): Promise<{
  ok: boolean;
  sent?: number;
  tokens?: number;
  error?: string;
}> {
  try {
    const headers = await authJsonHeaders();
    const res = await fetch('/api/push/test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || 'Test push failed.' };
    }
    return { ok: true, sent: data.sent, tokens: data.tokens };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Test push failed.' };
  }
}

export function isStandalonePwa(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function isIosDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
