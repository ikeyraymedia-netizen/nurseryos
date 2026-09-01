/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBxljPxYARoPhaq2RYHl4eerI3QNNYmco8',
  authDomain: 'nurseryos-54c15.firebaseapp.com',
  projectId: 'nurseryos-54c15',
  storageBucket: 'nurseryos-54c15.firebasestorage.app',
  messagingSenderId: '504651276318',
  appId: '1:504651276318:web:6bd26c6539fa829dbe0e0f'
});

const messaging = firebase.messaging();

function payloadTitle(payload) {
  return payload?.notification?.title || payload?.data?.title || 'NurseryOS';
}

function payloadBody(payload) {
  return payload?.notification?.body || payload?.data?.body || '';
}

function payloadUrl(payload) {
  return payload?.data?.url || payload?.fcmOptions?.link || '/';
}

function showPushNotification(payload) {
  const title = payloadTitle(payload);
  const body = payloadBody(payload);
  const url = payloadUrl(payload);
  const icon = self.location.origin + '/favicon.png';
  return self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag: 'nurseryos-' + Date.now(),
    renotify: true,
    data: { url }
  });
}

// Data-only / custom payloads (lock screen when app is backgrounded).
messaging.onBackgroundMessage((payload) => showPushNotification(payload));

// Fallback for browsers that deliver raw push events.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { data: { body: event.data.text() } };
  }
  event.waitUntil(showPushNotification(payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/';
  const targetUrl = rawUrl.startsWith('http') ? rawUrl : self.location.origin + rawUrl;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
