self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {}

  const title = data.title || "Новое сообщение";
  const body = data.body || "Откройте чат";
  const chatId = data.chat_id;

  const options = {
    body,
    data: { chatId },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const chatId = event.notification?.data?.chatId;
  const target = chatId ? `/?chat=${encodeURIComponent(String(chatId))}` : "/";

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });

      for (const c of allClients) {
        try {
          if ("focus" in c) {
            await c.focus();
            if ("navigate" in c) await c.navigate(target);
            return;
          }
        } catch (_) {}
      }

      if (clients.openWindow) {
        await clients.openWindow(target);
      }
    })()
  );
});