/* backend_app/frontend/static/sw.js
   Telegram Web–style push behavior

   Логика как в Telegram Web:

   1. Если приложение открыто и ВИДИМО (visibilityState === "visible"):
      → НЕ показываем системный push
      → отправляем событие в страницу (in-app toast)

   2. Если приложение скрыто или закрыто:
      → показываем системный push с:
        - ником
        - аватаркой
        - текстом
        - группировкой по chatId

   3. Клик по push:
      → открывает /?chat=ID
*/

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {}

  const chatId =
    data.chat_id ??
    data.chatId ??
    null;

  const chatStr =
    chatId !== null && chatId !== undefined
      ? String(chatId)
      : null;

  const senderUsername =
    String(data.sender_username || "").trim();

  const senderDisplay =
    String(
      data.sender_display ||
      (senderUsername ? "@" + senderUsername : "Новое сообщение")
    ).trim();

  const title =
    String(
      data.title ||
      senderDisplay ||
      "Новое сообщение"
    ).trim();

  const body =
    String(
      data.body ||
      data.text ||
      ""
    ).trim();

  const icon =
    String(
      data.avatar_icon_url ||
      data.icon ||
      "/static/icon-192.png"
    ).trim();

  const badge =
    String(
      data.badge ||
      icon
    ).trim();

  // =========================
  // TELEGRAM WEB RULE
  // =========================
  // если есть хотя бы одна видимая вкладка → НЕ показываем push
  // =========================

  try {
    const clientsArr =
      await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

    const visibleClients =
      clientsArr.filter(
        (c) =>
          c &&
          c.visibilityState === "visible"
      );

    if (visibleClients.length > 0) {
      for (const client of visibleClients) {
        try {
          client.postMessage({
            type: "push:foreground",
            data: {
              ...data,
              chat_id: chatId,
              chatId: chatId,
              title,
              body,
              sender_display: senderDisplay,
              avatar_icon_url: icon,
            },
          });
        } catch (_) {}
      }

      return;
    }
  } catch (_) {}

  // =========================
  // показать системное уведомление
  // =========================

  const options = {

    body: body,

    icon: icon || undefined,

    badge: badge || undefined,

    tag:
      chatStr
        ? "chat:" + chatStr
        : undefined,

    renotify: false,

    data: {

      chatId: chatId,

      chat_id: chatId,

      message_id:
        data.message_id ??
        null,

    },

  };

  await self.registration.showNotification(
    title,
    options
  );
}

self.addEventListener(
  "notificationclick",
  (event) => {

    event.notification.close();

    const chatId =
      event.notification?.data?.chatId ??
      event.notification?.data?.chat_id ??
      null;

    const targetUrl =
      chatId !== null && chatId !== undefined
        ? "/?chat=" + encodeURIComponent(String(chatId))
        : "/";

    event.waitUntil(
      openOrFocus(targetUrl)
    );
  }
);

async function openOrFocus(url) {

  const clientsArr =
    await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

  for (const client of clientsArr) {

    try {

      if ("focus" in client) {

        await client.focus();

        if ("navigate" in client)
          await client.navigate(url);

        return;
      }

    } catch (_) {}

  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(url);
  }
}