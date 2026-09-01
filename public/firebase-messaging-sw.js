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

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'NurseryOS';
  const body = payload.notification?.body || '';
  const url = payload.data?.url || '/';
  self.registration.showNotification(title, {
    body,
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: { url }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
