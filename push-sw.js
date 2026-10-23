self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('Notificación push recibida con formato incorrecto:', error);
  }
  const title = data.title || 'James Barbershop';
  const options = {
    body: data.body || 'Tienes una reserva pendiente.',
    icon: data.icon || 'https://i.ibb.co/JFrnTqWc/c4497cf0-2f10-43bf-b5ac-6c232c4d0e18.jpg',
    badge: data.badge || data.icon || 'https://i.ibb.co/JFrnTqWc/c4497cf0-2f10-43bf-b5ac-6c232c4d0e18.jpg',
    tag: data.tag || 'jb-reserva',
    renotify: false,
    data: { url: data.data?.url || '/' },
    actions: [{ action: 'open', title: 'Ver mi reserva' }]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let destination = self.location.origin;
  try {
    const requestedDestination = new URL(event.notification.data?.url || '/', self.location.origin);
    if (requestedDestination.origin === self.location.origin) destination = requestedDestination.href;
  } catch (error) {
    console.error('La notificación contenía un enlace no válido:', error);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.navigate(destination);
        return client.focus();
      }
    }
    return self.clients.openWindow(destination);
  })());
});
